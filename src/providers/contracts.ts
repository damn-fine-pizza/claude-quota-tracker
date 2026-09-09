import type { RunActuals, Task, WindowReading } from "../types.js";

/** A source observes budget; it never executes user work. */
export interface BudgetSource {
  readonly id: string;
  readonly providerId: string;
  readonly profileId: string;
  fetchBudgetSnapshot(nowMs?: number): Promise<WindowReading[]>;
}

export interface ExecutionRequest {
  task: Task;
  cwd: string;
  timeoutMs: number;
}

export interface ExecutionOutcome {
  actuals: RunActuals;
  success: boolean;
}

export interface ExecutionCapabilities {
  permissionClasses: readonly Task["permissionClass"][];
  supportsResume: boolean;
  supportsStructuredOutput: boolean;
}

/** An execution backend runs tasks; quota visibility is deliberately separate. */
export interface ExecutionBackend {
  readonly id: string;
  readonly providerId: string;
  readonly profileId: string;
  capabilities(): ExecutionCapabilities;
  execute(request: ExecutionRequest): Promise<ExecutionOutcome>;
}
