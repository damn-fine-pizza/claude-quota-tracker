import { realExec, type ExecFn } from "../runner.js";
import type { ExecutionBackend, ExecutionCapabilities, ExecutionOutcome, ExecutionRequest } from "./contracts.js";

/** Manual-only backend: no budget source, no automatic routing, never --yolo. */
export class CodexExecutionBackend implements ExecutionBackend {
  readonly id = "codex-exec"; readonly providerId = "codex"; readonly profileId = "codex-manual";
  constructor(private readonly exec: ExecFn = realExec, private readonly bin = "codex") {}
  capabilities(): ExecutionCapabilities { return { permissionClasses: ["read-only", "write-scoped"], supportsResume: false, supportsStructuredOutput: true }; }
  async execute(request: ExecutionRequest): Promise<ExecutionOutcome> {
    const sandbox = request.task.permissionClass === "read-only" ? "read-only" : "workspace-write";
    const r = await this.exec(this.bin, ["exec", "--json", "--sandbox", sandbox, request.task.prompt], { cwd: request.cwd, timeoutMs: request.timeoutMs });
    return { success: r.exitCode === 0 && !r.timedOut, actuals: { model: null, sessionId: null, inputTokens: null, outputTokens: null, cacheCreationTokens: null, cacheReadTokens: null, totalCostUsd: null, durationMs: null, result: r.exitCode === 0 ? "success" : "error", error: r.exitCode === 0 ? null : r.stderr || "codex exec failed", rawJson: r.stdout || null } };
  }
}
