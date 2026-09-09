const DAY_MS = 24 * 60 * 60 * 1000;

export interface PacingWindowInput {
  name: "session" | "weekly";
  nowMs: number;
  currentPct: number | null;
  resetEpochMs: number | null;
  windowDurationMs: number;
  budgetPct: number;
  slackPct: number;
  /**
   * The poller's burn-rate projection for usage at reset (see forecast.ts),
   * or null before enough history exists. Drives the actual admission
   * decision — falls back to `currentPct` (a flat-trend assumption) when null.
   */
  predictedPctAtReset: number | null;
}

export interface PacingWindowStatus {
  name: "session" | "weekly";
  currentPct: number;
  /** Ideal linear pace since the last reset — informational (no longer gates admission). */
  targetPct: number;
  allowedPct: number;
  elapsedFraction: number;
  aheadByPct: number;
  /** Remaining budget spread evenly over the remaining time to reset, expressed per day. */
  idealDailyPct: number;
  predictedPctAtReset: number;
  /** True once the current burn rate would land past budget+slack before reset. */
  onPaceToExceed: boolean;
}

export type PacingVerdict =
  | { ok: true; windows: PacingWindowStatus[] }
  | { ok: false; reason: string; windows: PacingWindowStatus[] };

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * Compute pacing status for one quota window.
 *
 * `budgetPct` is normally the existing hard guard (for example 80 for the
 * 5-hour session window). Admission is gated on `onPaceToExceed`: whether the
 * poller's burn-rate projection (`predictedPctAtReset`, from forecast.ts) would
 * land past `budgetPct + slackPct` by reset. This replaces gating on the ideal
 * linear-since-last-reset curve, which punished being "ahead" of an assumed-flat
 * pace even when the actual recent trend was perfectly safe (e.g. 36% used
 * against a ~15% ideal-so-far target would block for a day+, despite the
 * burn rate projecting a harmless 70% by the real reset). `targetPct`/
 * `allowedPct`/`elapsedFraction` are kept as informational reference points;
 * `idealDailyPct` (remaining budget over remaining time) is the more useful
 * "how much can I spend per day from here" figure to surface to a user.
 */
export function pacingWindowStatus(input: PacingWindowInput):
  | { ok: true; status: PacingWindowStatus }
  | { ok: false; reason: string } {
  const {
    name, nowMs, currentPct, resetEpochMs, windowDurationMs, budgetPct, slackPct, predictedPctAtReset,
  } = input;

  if (currentPct === null || resetEpochMs === null) {
    return { ok: false, reason: `${name} pacing data missing` };
  }
  if (!Number.isFinite(currentPct) || currentPct < 0) {
    return { ok: false, reason: `${name} usage is invalid` };
  }
  if (!Number.isFinite(windowDurationMs) || windowDurationMs <= 0) {
    return { ok: false, reason: `${name} window duration is invalid` };
  }
  if (!Number.isFinite(budgetPct) || budgetPct <= 0 || budgetPct > 100) {
    return { ok: false, reason: `${name} pacing budget is invalid` };
  }
  if (!Number.isFinite(slackPct) || slackPct < 0) {
    return { ok: false, reason: `${name} pacing slack is invalid` };
  }
  if (predictedPctAtReset !== null && !Number.isFinite(predictedPctAtReset)) {
    return { ok: false, reason: `${name} pacing forecast is invalid` };
  }
  if (resetEpochMs <= nowMs) {
    return { ok: false, reason: `${name} reset timestamp is stale` };
  }

  const startMs = resetEpochMs - windowDurationMs;
  const elapsedFraction = clamp01((nowMs - startMs) / windowDurationMs);
  const targetPct = budgetPct * elapsedFraction;
  const allowedPct = Math.min(budgetPct, targetPct + slackPct);

  const remainingBudgetPct = Math.max(0, budgetPct - currentPct);
  const remainingMs = Math.max(0, resetEpochMs - nowMs);
  const idealDailyPct = remainingMs > 0 ? remainingBudgetPct / (remainingMs / DAY_MS) : 0;

  // No forecast yet (fresh poll, no history) -> assume a flat trend from here.
  const predicted = predictedPctAtReset ?? currentPct;

  return {
    ok: true,
    status: {
      name,
      currentPct,
      targetPct,
      allowedPct,
      elapsedFraction,
      aheadByPct: currentPct - targetPct,
      idealDailyPct,
      predictedPctAtReset: predicted,
      onPaceToExceed: predicted > budgetPct + slackPct,
    },
  };
}

/**
 * Admission control for queued background work. Both windows must be on a
 * burn-rate trajectory that stays under budget by reset; whichever is
 * furthest over becomes the bottleneck. Hard exhaustion guards remain a
 * separate, authoritative layer.
 */
export function quotaPacingVerdict(args: {
  enabled: boolean;
  nowMs: number;
  sessionPct: number | null;
  sessionResetMs: number | null;
  weeklyPct: number | null;
  weeklyResetMs: number | null;
  sessionBudgetPct: number;
  weeklyBudgetPct: number;
  slackPct: number;
  sessionWindowMs: number;
  weeklyWindowMs: number;
  sessionPredictedPctAtReset: number | null;
  weeklyPredictedPctAtReset: number | null;
}): PacingVerdict {
  if (!args.enabled) return { ok: true, windows: [] };

  const results = [
    pacingWindowStatus({
      name: "session",
      nowMs: args.nowMs,
      currentPct: args.sessionPct,
      resetEpochMs: args.sessionResetMs,
      windowDurationMs: args.sessionWindowMs,
      budgetPct: args.sessionBudgetPct,
      slackPct: args.slackPct,
      predictedPctAtReset: args.sessionPredictedPctAtReset,
    }),
    pacingWindowStatus({
      name: "weekly",
      nowMs: args.nowMs,
      currentPct: args.weeklyPct,
      resetEpochMs: args.weeklyResetMs,
      windowDurationMs: args.weeklyWindowMs,
      budgetPct: args.weeklyBudgetPct,
      slackPct: args.slackPct,
      predictedPctAtReset: args.weeklyPredictedPctAtReset,
    }),
  ];

  for (const result of results) {
    if (!result.ok) return { ok: false, reason: result.reason, windows: [] };
  }

  const windows = results.map((r) => {
    if (!r.ok) throw new Error("unreachable pacing result");
    return r.status;
  });
  const budgetPlusSlack = (name: "session" | "weekly") =>
    (name === "session" ? args.sessionBudgetPct : args.weeklyBudgetPct) + args.slackPct;
  const blocked = windows
    .filter((w) => w.onPaceToExceed)
    .sort(
      (a, b) =>
        (b.predictedPctAtReset - budgetPlusSlack(b.name)) -
        (a.predictedPctAtReset - budgetPlusSlack(a.name)),
    )[0];

  if (blocked) {
    return {
      ok: false,
      reason:
        `${blocked.name} pacing: projected ${blocked.predictedPctAtReset.toFixed(1)}% by reset > ` +
        `${budgetPlusSlack(blocked.name).toFixed(1)}% budget+slack ` +
        `(currently ${blocked.currentPct.toFixed(1)}%); wait for the burn rate to cool down`,
      windows,
    };
  }

  return { ok: true, windows };
}
