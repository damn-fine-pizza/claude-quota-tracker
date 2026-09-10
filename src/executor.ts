import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DATA_DIR, DB_PATH, LATEST_JSON_PATH, loadConfig,
  type Config, type ExecutorConfig,
} from "./config.js";
import { acquireLock, isPidAlive, releaseLock } from "./lockfile.js";
import { sendMacNotification } from "./notify.js";
import { createDefaultProviderRegistry, type ExecutionBackend } from "./providers/index.js";
import { resolveBackend } from "./dispatch.js";
import { SchedulerMetaStore } from "./scheduler-meta.js";
import {
  CLAUDE_DEFAULT_PROFILE_ID, CLAUDE_PROVIDER_ID, profileCache, readLatestCache,
} from "./latest-cache.js";
import { addWorktree, type ExecFn } from "./runner.js";
import { Store } from "./store.js";
import {
  isLatestFresh, windowGuard, type GuardInput,
} from "./tasks.js";
import type { Task } from "./types.js";

/**
 * Freshly claimed tasks are skipped by stale recovery for this long: there is
 * a window between claim (status=running) and the run row insert during which
 * the task would otherwise look dead — recovering it then double-runs it.
 */
const RECOVER_GRACE_MS = 2 * 60 * 1000;

/**
 * Shared across runNightLoop/runPacedOnce/runManualTask: only one Claude
 * execution runs system-wide at a time, whatever triggered it.
 */
const LOCK_PATH = join(DATA_DIR, "scheduler.lock");

export interface ExecutionDeps {
  backend?: ExecutionBackend;
  commandExec?: ExecFn;
  runContext?: {
    providerId: string;
    profileId: string;
    backendId: string;
    receiptId?: number | null;
    budgetSnapshot?: unknown;
  };
}

interface LatestSnapshot {
  generatedAtMs: number | null;
  guard: GuardInput;
}

function readLatest(nowMs: number): LatestSnapshot {
  const empty: GuardInput = {
    nowMs, sessionPct: null, sessionResetMs: null, weeklyPct: null, weeklyResetMs: null,
  };
  const latest = readLatestCache(LATEST_JSON_PATH);
  if (!latest) return { generatedAtMs: null, guard: empty };
  try {
    const profile = profileCache(latest, CLAUDE_PROVIDER_ID, CLAUDE_DEFAULT_PROFILE_ID);
    const windows = profile?.windows ?? [];
    const find = (key: string) => windows.find((w) => w.windowKey === key);
    const session = find("session_5h");
    const weekly = find("weekly_all");
    return {
      generatedAtMs: profile?.generatedAtMs ?? null,
      guard: {
        nowMs,
        sessionPct: session?.pct ?? null,
        sessionResetMs: session?.resetEpochMs ?? null,
        weeklyPct: weekly?.pct ?? null,
        weeklyResetMs: weekly?.resetEpochMs ?? null,
      },
    };
  } catch {
    return { generatedAtMs: null, guard: empty };
  }
}

function settleUnfinished(
  store: Store, nowMs: number, task: Task, cfg: ExecutorConfig, error: string,
): void {
  store.settleTask({
    ts: nowMs,
    taskId: task.id,
    status: task.attempts >= cfg.maxAttempts ? "failed" : "carried_over",
    lastError: error,
  });
}

/**
 * Recover running tasks whose process died (crash/reboot). Three protections
 * against recovering a task that is actually alive:
 *  - grace period after claim (run row may not exist yet),
 *  - live pid with an unfinished run row is trusted,
 *  - unless it has overrun its size timeout by 1.5x (pid-reuse false-alive).
 * Recovery honors maxAttempts so crash-looping tasks terminate in `failed`.
 */
export function recoverStaleRunning(store: Store, nowMs: number, cfg: ExecutorConfig): void {
  for (const task of store.listTasks(["running"])) {
    if (nowMs - task.updatedTs < RECOVER_GRACE_MS) continue;
    const run = store.latestRunForTask(task.id);
    if (run && run.endedTs === null && isPidAlive(run.pid)) {
      const timeoutMs = (cfg.taskTimeoutMinutes[task.size] ?? 60) * 60 * 1000;
      if (nowMs - run.startedTs <= timeoutMs * 1.5) continue; // genuinely alive
    }
    settleUnfinished(store, nowMs, task, cfg, "stale running task recovered (process died)");
  }
}

/** Run one claimed task end to end: run row first, then worktree, claude, settle. */
export async function executeTask(
  store: Store,
  task: Task,
  config: Config,
  guard: GuardInput,
  deps: ExecutionDeps = {},
): Promise<boolean> {
  const nowMs = Date.now();
  const timeoutMs = (config.executor.taskTimeoutMinutes[task.size] ?? 60) * 60 * 1000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    settleUnfinished(store, Date.now(), task, config.executor, `invalid timeout for size ${task.size}`);
    return false;
  }

  const backend = deps.backend ?? createDefaultProviderRegistry()
    .executionBackendFor(CLAUDE_PROVIDER_ID, CLAUDE_DEFAULT_PROFILE_ID);
  if (!backend) {
    settleUnfinished(store, Date.now(), task, config.executor, "execution backend unavailable for claude/claude-default");
    return false;
  }
  // The run row goes in before slow worktree/backend work so recovery can see it.
  const context = deps.runContext ?? {
    providerId: backend.providerId, profileId: backend.profileId, backendId: backend.id,
  };
  const runId = store.startRun({
    ts: nowMs, taskId: task.id, pid: process.pid, sizeAtRun: task.size,
    sessionPctBefore: guard.sessionPct, weeklyPctBefore: guard.weeklyPct,
    providerId: context.providerId, profileId: context.profileId, backendId: context.backendId,
    permissionClass: task.permissionClass, runCwd: task.cwd, worktreePath: null,
    receiptId: context.receiptId ?? null, configSnapshot: config, budgetSnapshot: context.budgetSnapshot,
  });

  const failRun = (error: string): false => {
    store.finishRun(runId, Date.now(), {
      model: null, sessionId: null, inputTokens: null, outputTokens: null,
      cacheCreationTokens: null, cacheReadTokens: null, totalCostUsd: null,
      durationMs: null, result: "error", error, rawJson: null,
    });
    settleUnfinished(store, Date.now(), task, config.executor, error);
    return false;
  };

  let cwd = task.cwd;
  let worktreePath: string | null = null;
  if (task.permissionClass === "write-scoped") {
    worktreePath = join(DATA_DIR, "worktrees", `task-${task.id}-${nowMs}`);
    mkdirSync(join(DATA_DIR, "worktrees"), { recursive: true });
    try {
      await addWorktree(task.cwd, worktreePath, deps.commandExec);
      cwd = worktreePath;
      store.setRunLocation(runId, cwd, worktreePath);
    } catch (e) {
      return failRun(`worktree setup failed: ${(e as Error).message}`);
    }
  }
  const { actuals, success } = await backend.execute({ task, cwd, timeoutMs });
  store.finishRun(runId, Date.now(), actuals);
  store.settleTask({
    ts: Date.now(),
    taskId: task.id,
    status: success
      ? "done"
      : task.attempts >= config.executor.maxAttempts ? "failed" : "carried_over",
    resumeSessionId: actuals.sessionId,
    worktreePath,
    lastError: success ? null : actuals.error ?? `run result: ${actuals.result}`,
  });
  return success;
}

/** Night loop: re-evaluate gates before every claim, drain until blocked. */
export async function runNightLoop(deps: ExecutionDeps = {}): Promise<void> {
  // Keep the public entrypoint, but do not maintain a second admission path.
  // Dynamic import avoids the executor <-> paced-executor implementation cycle.
  if (deps.backend || deps.commandExec) throw new Error("runNightLoop test dependencies are no longer supported; use executeTask");
  const { runPacedOnce } = await import("./paced-executor.js");
  await runPacedOnce();
}

export interface ManualRunResult {
  ok: boolean;
  reason?: "locked" | "guard" | "not_found" | "backend_unavailable" | "permission_unsupported" | "budget_unavailable";
}

/**
 * Manual attended run of one specific task (`--task <id>`, or MCP `run_now`):
 * bypasses the night-window gates (the user is watching) but still respects
 * the window guard and the shared execution lock, and records through the
 * same estimation path.
 */
export async function runManualTask(id: number, deps: ExecutionDeps = {}): Promise<ManualRunResult> {
  if (!acquireLock(LOCK_PATH)) {
    console.error(`[executor] task #${id} not run: another execution holds the lock`);
    return { ok: false, reason: "locked" };
  }
  const config = loadConfig();
  const store = new Store(DB_PATH);
  const metaStore = new SchedulerMetaStore(DB_PATH);
  try {
    const nowMs = Date.now();
    const queued = store.getTask(id);
    if (!queued || !["queued", "carried_over", "failed"].includes(queued.status)) {
      console.error(`[executor] task #${id} not found or not runnable`);
      return { ok: false, reason: "not_found" };
    }
    const scheduling = metaStore.getOrDefault(id);
    const resolved = deps.backend
      ? { ok: true as const, backend: deps.backend }
      : resolveBackend(createDefaultProviderRegistry(), queued, scheduling, "manual");
    if (!resolved.ok) {
      console.error(`[executor] task #${id} not run: ${resolved.reasonCode}`);
      return { ok: false, reason: resolved.reasonCode };
    }
    const latest = readLatest(nowMs);
    if (resolved.backend.providerId === CLAUDE_PROVIDER_ID && (
      latest.generatedAtMs === null ||
      !isLatestFresh(latest.generatedAtMs, nowMs, config.pollIntervalSeconds)
    )) {
      console.warn("[executor] warning: latest.json stale — guard uses old usage data");
    }
    const guardVerdict = resolved.backend.providerId === CLAUDE_PROVIDER_ID
      ? windowGuard(latest.guard, config.executor) : { ok: true as const };
    if (!guardVerdict.ok) {
      console.error(`[executor] window guard: ${guardVerdict.reason}`);
      return { ok: false, reason: "guard" };
    }
    const task = store.claimTaskById(nowMs, id);
    if (!task) {
      console.error(`[executor] task #${id} not found or not runnable`);
      return { ok: false, reason: "not_found" };
    }
    const ok = await executeTask(store, task, config, latest.guard, {
      ...deps, backend: resolved.backend,
      runContext: {
        providerId: scheduling.providerId, profileId: scheduling.profileId,
        backendId: resolved.backend.id, receiptId: deps.runContext?.receiptId ?? null,
        budgetSnapshot: deps.runContext?.budgetSnapshot ?? (resolved.backend.providerId === CLAUDE_PROVIDER_ID ? latest : null),
      },
    });
    return { ok };
  } finally {
    metaStore.close();
    store.close();
    releaseLock(LOCK_PATH);
  }
}

const isMain = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const taskFlag = process.argv.indexOf("--task");
  const entry = taskFlag !== -1
    ? runManualTask(Number(process.argv[taskFlag + 1]))
    : runNightLoop();
  entry.catch(async (e) => {
    console.error("[executor] fatal:", e);
    await sendMacNotification({
      mode: "underUse", windowKey: "session_5h",
      title: "llm-squeeze executor error",
      message: String(e).slice(0, 200),
    });
    process.exitCode = 1;
  });
}
