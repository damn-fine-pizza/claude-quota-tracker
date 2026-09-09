import { LATEST_JSON_PATH, loadConfig } from "./config.js";
import { exhaustionEpochMs, type Forecast } from "./forecast.js";
import { Store } from "./store.js";
import { SIZE_ESTIMATES, type TaskSize } from "./types.js";
import {
  CLAUDE_DEFAULT_PROFILE_ID, CLAUDE_PROVIDER_ID, profileCache, readLatestCache,
  type LatestWindow,
} from "./latest-cache.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Tier 1 hero: window gauges + forecast + 7-day KPI. */
export function overview(store: Store, nowMs: number) {
  const latest = readLatestCache(LATEST_JSON_PATH);
  const profile = profileCache(latest, CLAUDE_PROVIDER_ID, CLAUDE_DEFAULT_PROFILE_ID);
  const windows = (profile?.windows ?? []).map((w) => ({
    key: w.windowKey,
    label: w.name,
    unit: w.unit,
    value: w.value,
    source: w.source,
    reliability: w.reliability,
    pct: w.pct,
    resetEpochMs: w.resetEpochMs,
    forecast: w.forecast,
    exhaustionEpochMs:
      w.forecast && w.pct !== null && w.resetEpochMs !== null
        ? exhaustionEpochMs({
            nowMs,
            currentPct: w.pct,
            burnRatePctPerHour: w.forecast.burnRatePctPerHour,
            resetEpochMs: w.resetEpochMs,
          })
        : null,
  }));
  // Total usage (all Claude Code work) from ingested session logs.
  const usage = store.usageSummary(nowMs - 7 * DAY_MS, nowMs);
  // Cost/runs stay sourced from task_runs — usage_events has no cost, and runs
  // count llm-squeeze's own orchestrated tasks (a distinct, smaller number).
  const k = store.runCostSummary(nowMs - 7 * DAY_MS, nowMs);
  return {
    generatedAtMs: profile?.generatedAtMs ?? null,
    profileStatus: profile?.status ?? "unavailable",
    ageMin: profile?.generatedAtMs !== null && profile?.generatedAtMs !== undefined
      ? Math.round((nowMs - profile.generatedAtMs) / 60000) : null,
    planName: loadConfig().plan.name,
    windows,
    kpi: {
      tokens7d: usage.totalTokens,
      activeTokens7d: usage.activeTokens,
      cost7d: k.totalCostUsd,
      runs7d: k.runs,
      ingestMaxTsMs: usage.maxTsMs,
    },
    scopeNote: "total Claude Code usage (session-log based · excludes web/claude.ai)",
  };
}

/** Tier 2: per-model TOTAL usage + token-category split (from session logs). */
export function models(store: Store, fromTs: number, toTs: number) {
  return {
    from: fromTs,
    to: toTs,
    totals: store.usageModelTotals(fromTs, toTs),
    categories: store.usageTokenCategoryTotals(fromTs, toTs),
  };
}

/**
 * Tier 2: GitHub-style contribution — local-day buckets, gaps filled with 0.
 * Total daily tokens across all Claude Code work (from session logs).
 */
export function contrib(store: Store, fromTs: number, toTs: number) {
  const events = store.usageEventsInRange(fromTs, toTs);
  const byDay = new Map<number, { value: number; runs: number }>();
  const dayKey = (ts: number): number => {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0); // local midnight
    return d.getTime();
  };
  for (const e of events) {
    const key = dayKey(e.ts);
    const cur = byDay.get(key) ?? { value: 0, runs: 0 };
    cur.value += e.totalTokens;
    cur.runs += 1;
    byDay.set(key, cur);
  }
  // Fill every local day in range so the heatmap grid is continuous. Step by
  // calendar day (setDate), not += DAY_MS — fixed-ms steps drift across DST
  // days (23/25h) and miss/duplicate buckets. Cap the grid so a huge or
  // malformed range can't blow up memory.
  const MAX_DAYS = 370;
  const days: Array<{ day: number; value: number; runs: number }> = [];
  const cur = new Date(fromTs);
  cur.setHours(0, 0, 0, 0);
  for (let i = 0; i < MAX_DAYS && cur.getTime() <= toTs; i++) {
    const key = cur.getTime();
    const e = byDay.get(key);
    days.push({ day: key, value: e?.value ?? 0, runs: e?.runs ?? 0 });
    cur.setDate(cur.getDate() + 1);
  }
  return { from: fromTs, to: toTs, metric: "tokens", days };
}

/** Tier 3: per-window usage time series. */
export function timeseries(store: Store, nowMs: number) {
  const out: Record<string, Array<{ ts: number; pct: number }>> = {};
  const profile = profileCache(readLatestCache(LATEST_JSON_PATH), CLAUDE_PROVIDER_ID, CLAUDE_DEFAULT_PROFILE_ID);
  for (const window of profile?.windows ?? []) {
    if (window.durationMs === null || window.unit !== "percent") continue;
    const { windowKey: key, durationMs: dur } = window;
    out[key] = store
      .history(profile?.providerId ?? CLAUDE_PROVIDER_ID, key, nowMs - dur)
      .map((p) => ({ ts: p.ts, pct: p.pct }));
  }
  return out;
}

/** Tier 3: estimate vs actual, plus per-size accuracy summary. */
export function estimates(store: Store) {
  const records = store.estimationRecords();
  const bySize = new Map<TaskSize, number[]>();
  for (const r of records) {
    if (r.actualTokens === null || !r.estimateTokens) continue;
    const ratio = r.actualTokens / r.estimateTokens;
    const arr = bySize.get(r.size) ?? [];
    arr.push(ratio);
    bySize.set(r.size, arr);
  }
  const summary = (Object.keys(SIZE_ESTIMATES) as TaskSize[])
    .filter((s) => bySize.has(s))
    .map((s) => {
      const ratios = bySize.get(s)!.sort((a, b) => a - b);
      const mid = Math.floor(ratios.length / 2);
      const median = ratios.length % 2
        ? ratios[mid]
        : (ratios[mid - 1] + ratios[mid]) / 2;
      return { size: s, medianRatio: median, n: ratios.length };
    });
  return { records, summary };
}

export function queue(store: Store) {
  return store.queueCounts();
}
