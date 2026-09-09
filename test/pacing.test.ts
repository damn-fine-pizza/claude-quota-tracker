import { describe, expect, it } from "vitest";
import { pacingWindowStatus, quotaPacingVerdict } from "../src/pacing.js";

const H = 60 * 60 * 1000;
const DAY = 24 * H;
const now = new Date("2026-09-07T12:00:00.000Z").getTime();

describe("pacingWindowStatus", () => {
  it("computes the ideal linear-from-last-reset curve, the remaining-budget daily rate, and the burn-rate verdict", () => {
    const r = pacingWindowStatus({
      name: "session",
      nowMs: now,
      currentPct: 30,
      resetEpochMs: now + 2.5 * H,
      windowDurationMs: 5 * H,
      budgetPct: 80,
      slackPct: 5,
      predictedPctAtReset: 42,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Legacy "ideal pace since last reset" figures, unchanged — informational only now.
    expect(r.status.elapsedFraction).toBeCloseTo(0.5);
    expect(r.status.targetPct).toBeCloseTo(40);
    expect(r.status.allowedPct).toBeCloseTo(45);
    // Remaining budget (80-30=50) spread over the remaining 2.5h -> a huge
    // per-day rate for a 5h window, which is expected (daily framing only
    // really makes sense for the weekly window); the math must still hold.
    expect(r.status.idealDailyPct).toBeCloseTo((80 - 30) / (2.5 * H / DAY));
    // 42% projected at reset is comfortably under budget(80)+slack(5)=85.
    expect(r.status.predictedPctAtReset).toBe(42);
    expect(r.status.onPaceToExceed).toBe(false);
  });

  it("flags onPaceToExceed once the forecast crosses budget+slack", () => {
    const r = pacingWindowStatus({
      name: "weekly",
      nowMs: now,
      currentPct: 40,
      resetEpochMs: now + 3.5 * DAY,
      windowDurationMs: 7 * DAY,
      budgetPct: 95,
      slackPct: 5,
      predictedPctAtReset: 101,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status.onPaceToExceed).toBe(true);
  });

  it("falls back to currentPct when no forecast is available yet (fresh poll, no history)", () => {
    const r = pacingWindowStatus({
      name: "session",
      nowMs: now,
      currentPct: 90,
      resetEpochMs: now + 2.5 * H,
      windowDurationMs: 5 * H,
      budgetPct: 80,
      slackPct: 5,
      predictedPctAtReset: null,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status.predictedPctAtReset).toBe(90);
    expect(r.status.onPaceToExceed).toBe(true); // 90 > 80+5
  });

  it("fails closed on missing usage data", () => {
    expect(pacingWindowStatus({
      name: "weekly",
      nowMs: now,
      currentPct: null,
      resetEpochMs: now + DAY,
      windowDurationMs: 7 * DAY,
      budgetPct: 95,
      slackPct: 5,
      predictedPctAtReset: null,
    }).ok).toBe(false);
  });
});

describe("quotaPacingVerdict", () => {
  const base = {
    enabled: true,
    nowMs: now,
    sessionPct: 30,
    sessionResetMs: now + 2.5 * H,
    weeklyPct: 40,
    weeklyResetMs: now + 3.5 * DAY,
    sessionBudgetPct: 80,
    weeklyBudgetPct: 95,
    slackPct: 5,
    sessionWindowMs: 5 * H,
    weeklyWindowMs: 7 * DAY,
    // Both comfortably under budget+slack (85 / 100) by default.
    sessionPredictedPctAtReset: 40,
    weeklyPredictedPctAtReset: 60,
  };

  it("allows work when both windows are projected to land safely under budget", () => {
    expect(quotaPacingVerdict(base).ok).toBe(true);
  });

  it("blocks when the session window is on pace to exceed its budget", () => {
    const v = quotaPacingVerdict({ ...base, sessionPredictedPctAtReset: 90 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("session pacing");
  });

  it("blocks when the weekly window is the bottleneck", () => {
    const v = quotaPacingVerdict({ ...base, weeklyPredictedPctAtReset: 130 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("weekly pacing");
  });

  it("does not block on cumulative usage alone when the recent trend is safe (the bug this replaces)", () => {
    // 36% used against an elapsed-fraction target of ~15% would have blocked
    // under the old curve-only model, but the actual burn rate projects a
    // harmless 70% by reset — this must now be allowed.
    const v = quotaPacingVerdict({ ...base, weeklyPct: 36, weeklyPredictedPctAtReset: 70 });
    expect(v.ok).toBe(true);
  });

  it("uses slack as a tolerance band around the budget threshold", () => {
    expect(quotaPacingVerdict({ ...base, sessionPredictedPctAtReset: 84 }).ok).toBe(true);
    expect(quotaPacingVerdict({ ...base, sessionPredictedPctAtReset: 86 }).ok).toBe(false);
  });

  it("falls back to currentPct (treats the trend as flat) when a forecast isn't available yet", () => {
    const v = quotaPacingVerdict({
      ...base, sessionPct: 90, sessionPredictedPctAtReset: null,
    });
    expect(v.ok).toBe(false);
  });

  it("is a no-op when disabled for backwards compatibility", () => {
    expect(quotaPacingVerdict({
      ...base,
      enabled: false,
      sessionPct: null,
      weeklyPct: null,
      sessionPredictedPctAtReset: null,
      weeklyPredictedPctAtReset: null,
    })).toEqual({ ok: true, windows: [] });
  });

  it("fails closed on stale reset metadata", () => {
    expect(quotaPacingVerdict({ ...base, sessionResetMs: now - 1 }).ok).toBe(false);
  });
});
