import { describe, expect, it } from "vitest";
import {
  createDefaultProviderRegistry, ProviderRegistry,
  type BudgetSource, type ExecutionBackend,
} from "../src/providers/index.js";

const budgetSource = (id: string): BudgetSource => ({
  id,
  providerId: "test-provider",
  profileId: "test-profile",
  fetchBudgetSnapshot: async () => [],
});

const executionBackend = (id: string): ExecutionBackend => ({
  id,
  providerId: "test-provider",
  profileId: "test-profile",
  capabilities: () => ({
    permissionClasses: ["read-only"],
    supportsResume: false,
    supportsStructuredOutput: true,
  }),
  execute: async () => ({
    success: false,
    actuals: {
      model: null, sessionId: null, inputTokens: null, outputTokens: null,
      cacheCreationTokens: null, cacheReadTokens: null, totalCostUsd: null,
      durationMs: null, result: "not-run", error: "test", rawJson: null,
    },
  }),
});

describe("ProviderRegistry", () => {
  it("keeps budget sources and execution backends separate", () => {
    const registry = new ProviderRegistry()
      .registerBudgetSource(budgetSource("budget-b"))
      .registerBudgetSource(budgetSource("budget-a"))
      .registerExecutionBackend(executionBackend("exec-a"));

    expect(registry.budgetSources().map((source) => source.id)).toEqual(["budget-a", "budget-b"]);
    expect(registry.executionBackends().map((backend) => backend.id)).toEqual(["exec-a"]);
    expect(registry.requireBudgetSource("budget-a").providerId).toBe("test-provider");
    expect(registry.requireExecutionBackend("exec-a").providerId).toBe("test-provider");
  });

  it("rejects duplicate ids within each capability registry", () => {
    const registry = new ProviderRegistry().registerBudgetSource(budgetSource("same"));
    expect(() => registry.registerBudgetSource(budgetSource("same"))).toThrow("duplicate budget source");

    registry.registerExecutionBackend(executionBackend("same"));
    expect(() => registry.registerExecutionBackend(executionBackend("same"))).toThrow("duplicate execution backend");
  });

  it("builds the default Claude profile with both independent capabilities", () => {
    const registry = createDefaultProviderRegistry();
    expect(registry.budgetSources()).toHaveLength(1);
    expect(registry.executionBackends()).toHaveLength(1);
    expect(registry.budgetSources()[0]).toMatchObject({
      id: "claude-cli-usage", providerId: "claude", profileId: "claude-default",
    });
    expect(registry.requireExecutionBackend("claude-cli")).toMatchObject({
      providerId: "claude", profileId: "claude-default",
    });
  });

  it("fails clearly when a requested backend is not registered", () => {
    expect(() => new ProviderRegistry().requireBudgetSource("missing"))
      .toThrow("budget source not registered: missing");
    expect(() => new ProviderRegistry().requireExecutionBackend("missing"))
      .toThrow("execution backend not registered: missing");
  });
});
