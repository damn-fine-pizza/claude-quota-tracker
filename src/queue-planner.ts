import type { Task } from "./types.js";
import type { QueueMode, TaskScheduleMeta } from "./scheduler-meta.js";
import type { RoutingPolicy } from "./routing-policy.js";
import { routeFor } from "./routing-policy.js";

export interface QueueDecision { taskId: number; ok: boolean; reasonCode: string; estimateTokens: number; providerId: string; profileId: string; }

/** Pure and deterministic: preview and execution must call this exact function. */
export function planQueue(args: { tasks: Task[]; meta: Map<number, TaskScheduleMeta>; mode: QueueMode; nowMs: number; cutoffMs: number | null; estimates: Map<number, number>; routing?: RoutingPolicy; reserveProfile?: string | null; dispatchReason?: (task: Task, meta: TaskScheduleMeta, providerId: string, profileId: string) => string | null }): QueueDecision[] {
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
    const routed=args.routing?routeFor(args.routing,m.category):null; const profile=routed?.profile??m.profileId;
    const reserved=args.reserveProfile===profile && m.intent!=="interactive";
    const dispatchReason = args.dispatchReason?.(task, m, m.providerId, profile) ?? null;
    const reasonCode = blocked !== "eligible" ? blocked : reserved ? "reserved_profile" : dispatchReason ?? "eligible";
    return { taskId: task.id, ok: reasonCode === "eligible", reasonCode, estimateTokens, providerId: m.providerId, profileId: profile };
  });
}
