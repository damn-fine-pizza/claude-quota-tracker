import { describe, expect, it } from "vitest";
import {
  emptyLatest, profileCache, profileCacheKey, withReliability, type LatestWindow,
} from "../src/latest-cache.js";

const window: LatestWindow = {
  windowKey: "session", name: "Session", unit: "percent", value: 12,
  source: "fixture", reliability: "observed", durationMs: 1_000,
  pct: 12, resetEpochMs: 2_000, raw: "fixture", forecast: null,
};

describe("profile latest cache", () => {
  it("selects a cache entry by both provider and profile", () => {
    const latest = emptyLatest(100);
    latest.profiles[profileCacheKey("provider-a", "alpha")] = {
      providerId: "provider-a", profileId: "alpha", status: "healthy",
      generatedAtMs: 100, windows: [window],
    };
    expect(profileCache(latest, "provider-a", "alpha")?.windows).toHaveLength(1);
    expect(profileCache(latest, "provider-b", "alpha")).toBeNull();
    expect(profileCache(latest, "provider-a", "missing")).toBeNull();
  });

  it("marks retained readings stale without changing their observation timestamp", () => {
    const stale = withReliability([window], "stale");
    expect(stale[0]).toMatchObject({ reliability: "stale", value: 12, resetEpochMs: 2_000 });
    expect(window.reliability).toBe("observed");
  });
});
