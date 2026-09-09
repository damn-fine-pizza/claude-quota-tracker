import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdirSync } from "node:fs";
import { z } from "zod";
import { DATA_DIR, DB_PATH, loadConfig, saveConfigPatch } from "../config.js";
import { runManualTask } from "../executor.js";
import { loadPacingConfig, mergePacingPatch } from "../pacing-config.js";
import { quotaPacingVerdict } from "../pacing.js";
import { readQuotaSnapshot } from "../quota-state.js";
import { SchedulerMetaStore } from "../scheduler-meta.js";
import { Store } from "../store.js";
import { TRIAGE, windowGuard } from "../tasks.js";

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function deadlineMs(v: string | number | null | undefined): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("deadline must be an ISO-8601 date/time or epoch milliseconds");
    return v;
  }
  const parsed = Date.parse(v);
  if (Number.isFinite(parsed)) return parsed;
  throw new Error("deadline must be an ISO-8601 date/time or epoch milliseconds");
}

/** Registers all quota-tracker tools on a fresh McpServer. Shared verbatim by the stdio and HTTP transports. */
export function registerTools(server: McpServer): void {
  mkdirSync(DATA_DIR, { recursive: true });

  server.registerTool(
    "submit_task",
    {
      description: "Queue Claude Code work for quota-aware execution. Use opportunistic for deferrable work, deadline for work that must finish by a time, interactive for manual-only work.",
      inputSchema: {
        prompt: z.string(),
        cwd: z.string(),
        size: z.enum(["xs", "s", "m", "l", "xl"]).default("m"),
        priority: z.number().default(0),
        intent: z.enum(["interactive", "deadline", "opportunistic"]).default("opportunistic"),
        deadline: z.union([z.string(), z.number(), z.null()]).optional(),
        estimated_tokens: z.number().optional(),
        permission: z.enum(["read-only", "write-scoped", "destructive"]).default("read-only"),
        continuous: z.boolean().default(false)
          .describe("Explicitly opt this task into unattended execution outside the confirmed night window."),
      },
    },
    async (args) => {
      const prompt = args.prompt.trim();
      const cwd = args.cwd.trim();
      if (!prompt || !cwd) throw new Error("prompt and cwd are required");
      const deadline = deadlineMs(args.deadline);
      if (args.intent === "deadline" && deadline === null) throw new Error("deadline intent requires deadline");
      if (deadline !== null && deadline <= Date.now()) throw new Error("deadline must be in the future");
      const rule = TRIAGE[args.permission];
      const continuous = args.continuous && rule.unattendedOk && args.intent !== "interactive";
      const store = new Store(DB_PATH);
      const meta = new SchedulerMetaStore(DB_PATH);
      try {
        const task = store.enqueueTask(Date.now(), {
          prompt, cwd, size: args.size, priority: args.priority,
          deferOk: args.intent !== "interactive",
          permissionClass: args.permission, permissionMode: rule.permissionMode,
          unattendedOk: rule.unattendedOk,
          scheduledWindow: continuous ? "any" : "night",
        });
        const m = meta.upsert(task.id, Date.now(), {
          intent: args.intent, deadlineMs: deadline,
          estimatedTokens: args.estimated_tokens ?? null,
          paused: false, continuousOk: continuous,
        });
        return text({
          task, scheduling: m,
          note: args.permission === "destructive" ? "destructive tasks are manual-only" : undefined,
        });
      } finally {
        meta.close();
        store.close();
      }
    },
  );

  server.registerTool(
    "get_quota_status",
    { description: "Return current Claude 5-hour and weekly quota readings and hard-guard status.", inputSchema: {} },
    async () => {
      const config = loadConfig();
      const nowMs = Date.now();
      const snapshot = readQuotaSnapshot(nowMs);
      const hard = windowGuard(snapshot.guard, config.executor);
      return text({ generatedAtMs: snapshot.generatedAtMs, ...snapshot.guard, hardGuard: hard });
    },
  );

  server.registerTool(
    "get_pacing_status",
    { description: "Return quota pacing targets and whether opportunistic work may run now.", inputSchema: {} },
    async () => {
      const config = loadConfig();
      const pacingCfg = loadPacingConfig();
      const nowMs = Date.now();
      const snapshot = readQuotaSnapshot(nowMs);
      const pacing = quotaPacingVerdict({
        enabled: pacingCfg.enabled, nowMs,
        sessionPct: snapshot.guard.sessionPct, sessionResetMs: snapshot.guard.sessionResetMs,
        weeklyPct: snapshot.guard.weeklyPct, weeklyResetMs: snapshot.guard.weeklyResetMs,
        sessionBudgetPct: config.executor.sessionGuardPct,
        weeklyBudgetPct: config.executor.weeklyGuardPct,
        slackPct: pacingCfg.slackPct,
        sessionWindowMs: pacingCfg.sessionWindowHours * 3_600_000,
        weeklyWindowMs: pacingCfg.weeklyWindowHours * 3_600_000,
        sessionPredictedPctAtReset: snapshot.sessionForecast?.predictedPctAtReset ?? null,
        weeklyPredictedPctAtReset: snapshot.weeklyForecast?.predictedPctAtReset ?? null,
      });
      return text({ pacing, config: pacingCfg });
    },
  );

  server.registerTool(
    "set_pacing_config",
    {
      description: "Update quota pacing settings (docs/MCP_SCHEDULER.md). Only the provided fields are changed; omitted fields keep their current value.",
      inputSchema: {
        enabled: z.boolean().optional(),
        slackPct: z.number().min(0).optional(),
        sessionWindowHours: z.number().min(0.1).optional(),
        weeklyWindowHours: z.number().min(0.1).optional(),
        continuousEnabled: z.boolean().optional()
          .describe("Permit explicitly opted-in tasks to run outside the confirmed night window."),
        deadlineSafetyMinutes: z.number().min(0).optional(),
        adaptiveMinSamples: z.number().min(1).optional(),
      },
    },
    async (args) => {
      const next = mergePacingPatch(loadPacingConfig(), args);
      saveConfigPatch({ pacing: next });
      return text(next);
    },
  );

  server.registerTool(
    "list_tasks",
    { description: "List queued/running/completed tasks with scheduling metadata.", inputSchema: {} },
    async () => {
      const store = new Store(DB_PATH);
      const meta = new SchedulerMetaStore(DB_PATH);
      try {
        return text(store.listTasks().map((task) => ({ task, scheduling: meta.getOrDefault(task.id) })));
      } finally {
        meta.close();
        store.close();
      }
    },
  );

  server.registerTool(
    "pause_task",
    { description: "Pause scheduler admission for one task.", inputSchema: { task_id: z.number() } },
    async ({ task_id }) => withTask(task_id, (store, meta) => text(meta.setPaused(task_id, true, Date.now()))),
  );

  server.registerTool(
    "resume_task",
    { description: "Resume scheduler admission for one task.", inputSchema: { task_id: z.number() } },
    async ({ task_id }) => withTask(task_id, (store, meta) => text(meta.setPaused(task_id, false, Date.now()))),
  );

  server.registerTool(
    "run_now",
    {
      description: "Manually run one queued task now. Hard quota guards and Claude permission rules still apply; pacing is bypassed.",
      inputSchema: { task_id: z.number() },
    },
    async ({ task_id }) => withTask(task_id, async (store, meta) => {
      meta.setPaused(task_id, false, Date.now());
      const result = await runManualTask(task_id);
      return text({ taskId: task_id, ...result });
    }),
  );

  server.registerTool(
    "update_task",
    {
      description: "Change a not-yet-started task: its prompt/cwd/size/permission content, and/or its priority, intent, deadline, or continuous eligibility. Only the provided fields are changed.",
      inputSchema: {
        task_id: z.number(),
        prompt: z.string().optional(),
        cwd: z.string().optional(),
        size: z.enum(["xs", "s", "m", "l", "xl"]).optional(),
        permission: z.enum(["read-only", "write-scoped", "destructive"]).optional()
          .describe("Re-triages permission_mode/unattendedOk to match; may also clear continuous eligibility (see continuousOk in the response)."),
        priority: z.number().optional(),
        intent: z.enum(["interactive", "deadline", "opportunistic"]).optional(),
        deadline: z.union([z.string(), z.number(), z.null()]).optional(),
        continuous: z.boolean().optional()
          .describe("Explicitly opt this task into unattended execution outside the confirmed night window."),
      },
    },
    async ({ task_id, prompt, cwd, size, permission, priority, intent, deadline, continuous }) => withTask(task_id, (store, meta) => {
      if (
        prompt === undefined && cwd === undefined && size === undefined && permission === undefined &&
        priority === undefined && intent === undefined && deadline === undefined && continuous === undefined
      ) {
        throw new Error("provide at least one of prompt, cwd, size, permission, priority, intent, deadline, continuous");
      }
      let task = store.getTask(task_id)!;
      if (prompt !== undefined || cwd !== undefined || size !== undefined || permission !== undefined) {
        if (task.status !== "queued" && task.status !== "carried_over") {
          throw new Error(`task #${task_id} is ${task.status} — only queued/carried_over tasks can have their content edited`);
        }
        const rule = permission !== undefined ? TRIAGE[permission] : null;
        const updated = store.updateTaskContent(task_id, Date.now(), {
          prompt, cwd, size,
          ...(rule ? { permissionClass: permission, permissionMode: rule.permissionMode, unattendedOk: rule.unattendedOk } : {}),
        });
        if (!updated) throw new Error(`task #${task_id} could not be updated`);
        task = updated;
      }
      if (priority !== undefined) {
        task = store.updateTaskPriority(task_id, priority, Date.now()) ?? task;
      }
      let scheduling = meta.getOrDefault(task_id);
      // Also re-run this when only `permission` changed: it may have flipped
      // unattendedOk (e.g. to destructive), which must zero out continuousOk
      // even though continuous/intent/deadline themselves weren't touched.
      if (intent !== undefined || deadline !== undefined || continuous !== undefined || permission !== undefined) {
        const nextIntent = intent ?? scheduling.intent;
        const nextDeadline = deadline === undefined ? scheduling.deadlineMs : deadlineMs(deadline);
        if (nextIntent === "deadline" && nextDeadline == null) throw new Error("deadline intent requires deadline");
        if (nextDeadline !== null && nextDeadline <= Date.now()) throw new Error("deadline must be in the future");
        const rule = TRIAGE[task.permissionClass];
        const nextContinuous = (continuous ?? scheduling.continuousOk) && rule.unattendedOk && nextIntent !== "interactive";
        scheduling = meta.upsert(task_id, Date.now(), {
          intent: nextIntent, deadlineMs: nextDeadline,
          estimatedTokens: scheduling.estimatedTokens,
          paused: scheduling.paused, continuousOk: nextContinuous,
        });
      }
      return text({ task, scheduling });
    }),
  );

  server.registerTool(
    "delete_task",
    {
      description: "Permanently remove a task (and its run history) from the queue. Refuses to delete a currently-running task.",
      inputSchema: { task_id: z.number() },
    },
    async ({ task_id }) => withTask(task_id, (store, meta) => {
      const task = store.getTask(task_id)!;
      if (task.status === "running") {
        throw new Error(`task #${task_id} is running — wait for it to finish before deleting`);
      }
      meta.delete(task_id);
      const deleted = store.deleteTask(task_id);
      return text({ deleted, taskId: task_id });
    }),
  );
}
async function withTask(
  taskId: number,
  fn: (store: Store, meta: SchedulerMetaStore) => unknown,
): Promise<ReturnType<typeof text>> {
  const store = new Store(DB_PATH);
  const meta = new SchedulerMetaStore(DB_PATH);
  try {
    if (!store.getTask(taskId)) throw new Error(`task #${taskId} not found`);
    return (await fn(store, meta)) as ReturnType<typeof text>;
  } finally {
    meta.close();
    store.close();
  }
}
