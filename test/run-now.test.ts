import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { acquireLock, releaseLock } from "../src/lockfile.js";
import { ClaudeExecutionBackend } from "../src/providers/index.js";
import type { ExecFn } from "../src/runner.js";
import type { TaskInput } from "../src/types.js";

const SUCCESS_JSON = JSON.stringify({
  type: "result", subtype: "success", is_error: false, duration_ms: 100,
  result: "ok", session_id: "sess-ok", total_cost_usd: 0.01,
  usage: {
    input_tokens: 10, output_tokens: 5,
    cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
  },
  modelUsage: { "claude-sonnet-4-6": { inputTokens: 10, outputTokens: 5 } },
  permission_denials: [],
});
const okExec: ExecFn = async () => ({ stdout: SUCCESS_JSON, stderr: "", exitCode: 0 });

// Isolated LLM_SQUEEZE_HOME, set before config.js is first imported — never
// the real ~/.llm-squeeze or this repo's own dev data/. Exercises the real
// DB_PATH-bound runManualTask (the run_now MCP tool's implementation), which
// cannot take an injected Store, so isolation has to happen at this level.
const homeDir = mkdtempSync(join(tmpdir(), "qt-run-now-"));
process.env.LLM_SQUEEZE_HOME = homeDir;

const { DATA_DIR, DB_PATH, LATEST_JSON_PATH } = await import("../src/config.js");
const { runManualTask } = await import("../src/executor.js");
const { Store } = await import("../src/store.js");

mkdirSync(DATA_DIR, { recursive: true });
// A fresh, comfortably-under-guard usage snapshot so windowGuard passes and
// runManualTask actually reaches the claim step instead of holding on the guard.
writeFileSync(LATEST_JSON_PATH, JSON.stringify({
  generatedAtMs: Date.now(),
  profiles: { "claude-default": {
    providerId: "claude", profileId: "claude-default", status: "healthy", generatedAtMs: Date.now(),
    windows: [
      {
        windowKey: "session_5h", name: "Session", unit: "percent", value: 10,
        source: "fixture", reliability: "observed", durationMs: 18_000_000,
        pct: 10, resetEpochMs: Date.now() + 3_600_000,
      },
      {
        windowKey: "weekly_all", name: "Week", unit: "percent", value: 10,
        source: "fixture", reliability: "observed", durationMs: 604_800_000,
        pct: 10, resetEpochMs: Date.now() + 7 * 86_400_000,
      },
    ],
  } },
}));

const LOCK_PATH = join(DATA_DIR, "scheduler.lock");

function taskInput(partial: Partial<TaskInput> = {}): TaskInput {
  return {
    prompt: "p", cwd: "/tmp", size: "xs", priority: 0, deferOk: true,
    permissionClass: "read-only", permissionMode: "default", unattendedOk: true,
    scheduledWindow: "night",
    ...partial,
  };
}

afterAll(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

describe("runManualTask (run_now)", () => {
  it("does not claim the task when the shared execution lock is already held", async () => {
    const store = new Store(DB_PATH);
    const task = store.enqueueTask(Date.now(), taskInput());
    store.close();

    expect(acquireLock(LOCK_PATH)).toBe(true);
    try {
      const result = await runManualTask(task.id);
      expect(result).toEqual({ ok: false, reason: "locked" });
    } finally {
      releaseLock(LOCK_PATH);
    }

    const after = new Store(DB_PATH);
    expect(after.getTask(task.id)?.status).toBe("queued"); // never claimed
    after.close();
  });

  it("reports not_found for a task id that doesn't exist", async () => {
    const result = await runManualTask(999_999_999);
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("claims and runs the task when unlocked and the guard passes", async () => {
    const store = new Store(DB_PATH);
    const task = store.enqueueTask(Date.now(), taskInput());
    store.close();

    const result = await runManualTask(task.id, {
      backend: new ClaudeExecutionBackend({ exec: okExec }),
    });
    expect(result).toEqual({ ok: true });

    const after = new Store(DB_PATH);
    expect(after.getTask(task.id)?.status).toBe("done");
    after.close();
  });
});
