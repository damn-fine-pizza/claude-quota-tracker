import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SchedulerMetaStore } from "../src/scheduler-meta.js";
import { Store } from "../src/store.js";
import type { TaskInput } from "../src/types.js";

function taskInput(partial: Partial<TaskInput> = {}): TaskInput {
  return {
    prompt: "do something", cwd: "/tmp", size: "xs", priority: 0, deferOk: true,
    permissionClass: "read-only", permissionMode: "default", unattendedOk: true,
    scheduledWindow: "night",
    ...partial,
  };
}

// task_schedule_meta.task_id REFERENCES tasks(id), so the DB needs the Store's
// tasks table to exist first — a bare :memory: SchedulerMetaStore can't create
// its table alone. Use a real per-test file (two :memory: connections are two
// independent databases, even with the same "path").
describe("SchedulerMetaStore.delete", () => {
  const dirs: string[] = [];
  function freshDbPath(): string {
    const dir = mkdtempSync(join(tmpdir(), "qt-scheduler-meta-"));
    dirs.push(dir);
    return join(dir, "quota.db");
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("removes a task's scheduling metadata, reverting getOrDefault to defaults", () => {
    const dbPath = freshDbPath();
    const store = new Store(dbPath);
    const task = store.enqueueTask(100, taskInput());
    const meta = new SchedulerMetaStore(dbPath);
    meta.upsert(task.id, 100, { intent: "opportunistic", continuousOk: true, paused: false, deadlineMs: null, estimatedTokens: null });
    expect(meta.get(task.id)).not.toBeNull();

    meta.delete(task.id);
    expect(meta.get(task.id)).toBeNull();
    expect(meta.getOrDefault(task.id).continuousOk).toBe(false);
    meta.close();
    store.close();
  });

  it("is a no-op for an id with no metadata row", () => {
    const dbPath = freshDbPath();
    const store = new Store(dbPath);
    const meta = new SchedulerMetaStore(dbPath);
    expect(() => meta.delete(999_999)).not.toThrow();
    meta.close();
    store.close();
  });
});
