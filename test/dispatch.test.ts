import { describe, expect, it } from "vitest";
import { resolveBackend } from "../src/dispatch.js";
import { createDefaultProviderRegistry } from "../src/providers/index.js";
import type { Task } from "../src/types.js";

const task: Task = { id: 1, createdTs: 0, updatedTs: 0, prompt: "p", cwd: "/tmp", size: "s", priority: 0, deferOk: true, permissionClass: "read-only", permissionMode: "default", unattendedOk: true, scheduledWindow: "night", status: "queued", attempts: 0, resumeSessionId: null, worktreePath: null, lastError: null };

describe("resolveBackend", () => {
  const registry = createDefaultProviderRegistry();
  it("admits Claude automation only with matching budget and backend", () => {
    expect(resolveBackend(registry, task, { providerId: "claude", profileId: "claude-default" }, "automatic").ok).toBe(true);
  });
  it("keeps Codex manual-only until it has a budget source", () => {
    expect(resolveBackend(registry, task, { providerId: "codex", profileId: "codex-manual" }, "manual").ok).toBe(true);
    expect(resolveBackend(registry, task, { providerId: "codex", profileId: "codex-manual" }, "automatic")).toEqual({ ok: false, reasonCode: "budget_unavailable" });
  });
  it("fails closed for unknown profiles and unsupported permissions", () => {
    expect(resolveBackend(registry, task, { providerId: "missing", profileId: "none" }, "manual")).toEqual({ ok: false, reasonCode: "backend_unavailable" });
    expect(resolveBackend(registry, { ...task, permissionClass: "destructive" }, { providerId: "codex", profileId: "codex-manual" }, "manual")).toEqual({ ok: false, reasonCode: "permission_unsupported" });
  });
});
