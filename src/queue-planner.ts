import type { Task } from "./types.js";
import type { QueueMode, TaskScheduleMeta } from "./scheduler-meta.js";

export interface QueueDecision { taskId: number; ok: boolean; reasonCode: string; estimateTokens: number; providerId: string; profileId: string; }

/** Pure and deterministic: preview and execution must call this exact function. */
export function planQueue(args: { tasks: Task[]; meta: Map<number, TaskScheduleMeta>; mode: QueueMode; nowMs: number; cutoffMs: number | null; estimates: Map<number, number> }): QueueDecision[] {
  const candidates = args.tasks.filter((task) => task.status === "queued" || task.status === "carried_over")
    .sort((a, b) => {
      const am = args.meta.get(a.id)!; const bm = args.meta.get(b.id)!;
      return args.mode === "manual" ? am.manualOrder - bm.manualOrder || a.createdTs - b.createdTs
        : b.priority - a.priority || a.createdTs - b.createdTs;
    });
  return candidates.map((task) => {
    const m = args.meta.get(task.id)!; const estimateTokens = args.estimates.get(task.id) ?? 0;
    const blocked = m.paused ? "paused" : !task.unattendedOk ? "permission_manual_only"
      : args.cutoffMs !== null && args.nowMs >= args.cutoffMs ? "cutoff_reached" : "eligible";
    return { taskId: task.id, ok: blocked === "eligible", reasonCode: blocked, estimateTokens, providerId: m.providerId, profileId: m.profileId };
  });
}
