import type { ExecutionBackend, ProviderRegistry } from "./providers/index.js";
import type { Task } from "./types.js";
import type { TaskScheduleMeta } from "./scheduler-meta.js";

export type DispatchMode = "manual" | "automatic";

export type BackendResolution =
  | { ok: true; backend: ExecutionBackend; providerId: string; profileId: string }
  | { ok: false; reasonCode: "backend_unavailable" | "permission_unsupported" | "budget_unavailable" };

/**
 * The only provider/profile-to-backend decision point. Automatic work needs
 * both independent capabilities; an attended run only needs a compatible
 * backend. This keeps a manual-only backend (such as Codex today) from ever
 * becoming an accidental routing fallback.
 */
export function resolveBackend(
  registry: ProviderRegistry,
  task: Task,
  scheduling: Pick<TaskScheduleMeta, "providerId" | "profileId">,
  mode: DispatchMode,
): BackendResolution {
  const backend = registry.executionBackendFor(scheduling.providerId, scheduling.profileId);
  if (!backend) return { ok: false, reasonCode: "backend_unavailable" };
  if (!backend.capabilities().permissionClasses.includes(task.permissionClass)) {
    return { ok: false, reasonCode: "permission_unsupported" };
  }
  if (mode === "automatic" && !registry.budgetSourceFor(scheduling.providerId, scheduling.profileId)) {
    return { ok: false, reasonCode: "budget_unavailable" };
  }
  return { ok: true, backend, providerId: scheduling.providerId, profileId: scheduling.profileId };
}
