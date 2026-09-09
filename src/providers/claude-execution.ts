import {
  runClaudeTask, type ClaudeRunOptions,
} from "../runner.js";
import type {
  ExecutionBackend, ExecutionCapabilities, ExecutionOutcome, ExecutionRequest,
} from "./contracts.js";

const CAPABILITIES: ExecutionCapabilities = {
  permissionClasses: ["read-only", "write-scoped", "destructive"],
  supportsResume: true,
  supportsStructuredOutput: true,
};

export class ClaudeExecutionBackend implements ExecutionBackend {
  readonly id = "claude-cli";
  readonly providerId = "claude";
  readonly profileId = "claude-default";

  constructor(private readonly options: ClaudeRunOptions = {}) {}

  capabilities(): ExecutionCapabilities {
    return CAPABILITIES;
  }

  execute(request: ExecutionRequest): Promise<ExecutionOutcome> {
    return runClaudeTask(request.task, request.cwd, request.timeoutMs, this.options);
  }
}
