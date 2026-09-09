import { readFileSync } from "node:fs";
import { CONFIG_PATH } from "./config.js";

export interface PacingConfig {
  mode: "protect" | "balanced" | "flush";
  enabled: boolean;
  slackPct: number;
  sessionWindowHours: number;
  weeklyWindowHours: number;
  /** Permit explicitly opted-in tasks to run outside the night window. */
  continuousEnabled: boolean;
  /** Extra wall-clock margin used when computing latest safe deadline start. */
  deadlineSafetyMinutes: number;
  /** Successful same-size runs required before historical estimation is trusted. */
  adaptiveMinSamples: number;
}

export const DEFAULT_PACING_CONFIG: PacingConfig = {
  mode: "balanced",
  enabled: false,
  slackPct: 5,
  sessionWindowHours: 5,
  weeklyWindowHours: 7 * 24,
  continuousEnabled: false,
  deadlineSafetyMinutes: 15,
  adaptiveMinSamples: 3,
};

export function loadPacingConfig(path: string = CONFIG_PATH): PacingConfig {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { pacing?: Partial<PacingConfig> };
    return { ...DEFAULT_PACING_CONFIG, ...(raw.pacing ?? {}) };
  } catch {
    return DEFAULT_PACING_CONFIG;
  }
}

export function num(v: unknown, current: number, min: number): number {
  if (v === undefined) return current;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min) throw new Error("invalid number");
  return v;
}
export function bool(v: unknown, current: boolean): boolean {
  if (v === undefined) return current;
  if (typeof v !== "boolean") throw new Error("invalid boolean");
  return v;
}
export function obj(v: unknown): Record<string, unknown> {
  if (v === undefined) return {};
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("expected an object");
  return v as Record<string, unknown>;
}

/**
 * Merges a partial patch onto the CURRENT full config (not just defaults), so
 * an unspecified field is never wiped — shared by the dashboard's /api/settings
 * and the set_pacing_config MCP tool, so the two can never disagree on what's valid.
 */
export function mergePacingPatch(current: PacingConfig, patch: unknown): PacingConfig {
  const p = obj(patch);
  return {
    mode: p.mode === "protect" || p.mode === "balanced" || p.mode === "flush" ? p.mode : current.mode,
    enabled: bool(p.enabled, current.enabled),
    slackPct: num(p.slackPct, current.slackPct, 0),
    sessionWindowHours: num(p.sessionWindowHours, current.sessionWindowHours, 0.1),
    weeklyWindowHours: num(p.weeklyWindowHours, current.weeklyWindowHours, 0.1),
    continuousEnabled: bool(p.continuousEnabled, current.continuousEnabled),
    deadlineSafetyMinutes: num(p.deadlineSafetyMinutes, current.deadlineSafetyMinutes, 0),
    adaptiveMinSamples: num(p.adaptiveMinSamples, current.adaptiveMinSamples, 1),
  };
}
