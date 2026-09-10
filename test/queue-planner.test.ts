import { describe, expect, it } from "vitest";
import { planQueue } from "../src/queue-planner.js";
import type { Task } from "../src/types.js";
import type { TaskScheduleMeta } from "../src/scheduler-meta.js";

const task = (id: number, priority: number): Task => ({ id, priority, createdTs: id, updatedTs: id, prompt: "p", cwd: "/tmp", size: "s", deferOk: true, permissionClass: "read-only", permissionMode: "default", unattendedOk: true, scheduledWindow: "night", status: "queued", attempts: 0, resumeSessionId: null, worktreePath: null, lastError: null });
const meta = (id: number, order: number): TaskScheduleMeta => ({ taskId: id, intent: "opportunistic", deadlineMs: null, estimatedTokens: 10, paused: false, continuousOk: false, titleMarkdown: null, providerId: "claude", profileId: "claude-default", model: null, category: null, manualOrder: order, queueMode: "manual", createdTs: 0, updatedTs: 0 });

describe("planQueue", () => {
  it("uses deterministic manual order and records cutoff decisions", () => {
    const tasks = [task(1, 99), task(2, 0)]; const metas = new Map([[1, meta(1, 2)], [2, meta(2, 1)]]);
    expect(planQueue({ tasks, meta: metas, mode: "manual", nowMs: 100, cutoffMs: null, estimates: new Map() }).map((d) => d.taskId)).toEqual([2, 1]);
    expect(planQueue({ tasks, meta: metas, mode: "manual", nowMs: 100, cutoffMs: 100, estimates: new Map() }).every((d) => d.reasonCode === "cutoff_reached")).toBe(true);
  });

  it("surfaces dispatch denials without making a task eligible", () => {
    const tasks = [task(1, 0)]; const metas = new Map([[1, meta(1, 1)]]);
    const [decision] = planQueue({
      tasks, meta: metas, mode: "priority", nowMs: 100, cutoffMs: null, estimates: new Map(),
      dispatchReason: () => "budget_unavailable",
    });
    expect(decision).toMatchObject({ ok: false, reasonCode: "budget_unavailable" });
  });
});
