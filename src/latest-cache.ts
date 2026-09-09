import { existsSync, readFileSync } from "node:fs";
import type { Forecast } from "./forecast.js";
import type { BudgetReliability, WindowReading } from "./types.js";

export type ProfileCacheStatus = "healthy" | "stale" | "unavailable";

export interface LatestWindow extends WindowReading {
  forecast: Forecast | null;
}

export interface ProfileCache {
  providerId: string;
  profileId: string;
  status: ProfileCacheStatus;
  /** Timestamp of the last successful observation for this profile. */
  generatedAtMs: number | null;
  windows: LatestWindow[];
}

export interface LatestJson {
  /** Cache file write time; use each profile timestamp for freshness decisions. */
  generatedAtMs: number;
  profiles: Record<string, ProfileCache>;
}

export const CLAUDE_PROVIDER_ID = "claude";
export const CLAUDE_DEFAULT_PROFILE_ID = "claude-default";

export function profileCacheKey(providerId: string, profileId: string): string {
  return `${providerId}/${profileId}`;
}

export function emptyLatest(nowMs: number): LatestJson {
  return { generatedAtMs: nowMs, profiles: {} };
}

export function readLatestCache(path: string): LatestJson | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as LatestJson;
    return parsed && typeof parsed === "object" && parsed.profiles ? parsed : null;
  } catch {
    return null;
  }
}

/** Query by provider/profile instead of coupling a consumer to cache layout. */
export function profileCache(
  latest: LatestJson | null,
  providerId: string,
  profileId: string,
): ProfileCache | null {
  const direct = latest?.profiles[profileCacheKey(providerId, profileId)] ?? null;
  if (direct) return direct;
  // A short-lived compatibility path for cache files produced by the first
  // profile-cache build, where profileId alone was the map key.
  const legacy = latest?.profiles[profileId] ?? null;
  return legacy?.providerId === providerId ? legacy : null;
}

export function withReliability(
  windows: LatestWindow[],
  reliability: BudgetReliability,
): LatestWindow[] {
  return windows.map((window) => ({ ...window, reliability }));
}
