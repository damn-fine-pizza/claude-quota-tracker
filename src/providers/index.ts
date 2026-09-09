import type { ExecFn } from "../runner.js";
import { ClaudeBudgetSource } from "./claude-budget.js";
import { ClaudeExecutionBackend } from "./claude-execution.js";
import type { BudgetSource, ExecutionBackend } from "./contracts.js";

export class ProviderRegistry {
  private readonly budgetSourcesById = new Map<string, BudgetSource>();
  private readonly executionBackendsById = new Map<string, ExecutionBackend>();

  registerBudgetSource(source: BudgetSource): this {
    if (this.budgetSourcesById.has(source.id)) throw new Error(`duplicate budget source: ${source.id}`);
    this.budgetSourcesById.set(source.id, source);
    return this;
  }

  registerExecutionBackend(backend: ExecutionBackend): this {
    if (this.executionBackendsById.has(backend.id)) throw new Error(`duplicate execution backend: ${backend.id}`);
    this.executionBackendsById.set(backend.id, backend);
    return this;
  }

  budgetSources(): BudgetSource[] {
    return [...this.budgetSourcesById.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  requireBudgetSource(id: string): BudgetSource {
    const source = this.budgetSourcesById.get(id);
    if (!source) throw new Error(`budget source not registered: ${id}`);
    return source;
  }

  executionBackends(): ExecutionBackend[] {
    return [...this.executionBackendsById.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  requireExecutionBackend(id: string): ExecutionBackend {
    const backend = this.executionBackendsById.get(id);
    if (!backend) throw new Error(`execution backend not registered: ${id}`);
    return backend;
  }
}

export interface DefaultRegistryOptions {
  claudeBin?: string;
  exec?: ExecFn;
}

export function createDefaultProviderRegistry(options: DefaultRegistryOptions = {}): ProviderRegistry {
  return new ProviderRegistry()
    .registerBudgetSource(new ClaudeBudgetSource(options.claudeBin))
    .registerExecutionBackend(new ClaudeExecutionBackend({
      claudeBin: options.claudeBin,
      exec: options.exec,
    }));
}

export { ClaudeBudgetSource, ClaudeExecutionBackend };
export type {
  BudgetSource, ExecutionBackend, ExecutionCapabilities, ExecutionOutcome, ExecutionRequest,
} from "./contracts.js";
