import { existsSync, readFileSync } from "node:fs";
import { LATEST_JSON_PATH } from "./config.js";
import type { Forecast } from "./forecast.js";
import type { GuardInput } from "./tasks.js";

export interface QuotaSnapshot {
  generatedAtMs: number | null;
  guard: GuardInput;
  /** The poller's already-computed burn-rate projection for each window (null until enough history exists). */
  sessionForecast: Forecast | null;
  weeklyForecast: Forecast | null;
}

export function readQuotaSnapshot(nowMs: number, path: string = LATEST_JSON_PATH): QuotaSnapshot {
  const empty: GuardInput = {
    nowMs, sessionPct: null, sessionResetMs: null, weeklyPct: null, weeklyResetMs: null,
  };
  if (!existsSync(path)) return { generatedAtMs: null, guard: empty, sessionForecast: null, weeklyForecast: null };
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as {
      generatedAtMs: number;
      providers: Record<string, { windows: Array<{
        windowKey: string; pct: number | null; resetEpochMs: number | null; forecast?: Forecast | null;
      }> }>;
    };
    const windows = j.providers["claude"]?.windows ?? [];
    const find = (key: string) => windows.find((w) => w.windowKey === key);
    const session = find("session_5h");
    const weekly = find("weekly_all");
    return {
      generatedAtMs: j.generatedAtMs,
      guard: {
        nowMs,
        sessionPct: session?.pct ?? null,
        sessionResetMs: session?.resetEpochMs ?? null,
        weeklyPct: weekly?.pct ?? null,
        weeklyResetMs: weekly?.resetEpochMs ?? null,
      },
      sessionForecast: session?.forecast ?? null,
      weeklyForecast: weekly?.forecast ?? null,
    };
  } catch {
    return { generatedAtMs: null, guard: empty, sessionForecast: null, weeklyForecast: null };
  }
}
