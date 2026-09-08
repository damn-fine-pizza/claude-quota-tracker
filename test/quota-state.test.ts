import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readQuotaSnapshot } from "../src/quota-state.js";

describe("readQuotaSnapshot", () => {
  const dir = mkdtempSync(join(tmpdir(), "qt-quota-state-"));
  const path = join(dir, "latest.json");

  afterEach(() => {
    rmSync(path, { force: true });
  });

  it("returns null guard/forecast fields when latest.json doesn't exist", () => {
    const snap = readQuotaSnapshot(1000, path);
    expect(snap.generatedAtMs).toBeNull();
    expect(snap.guard.sessionPct).toBeNull();
    expect(snap.sessionForecast).toBeNull();
    expect(snap.weeklyForecast).toBeNull();
  });

  it("passes through the poller's already-computed forecast per window", () => {
    writeFileSync(path, JSON.stringify({
      generatedAtMs: 5000,
      providers: {
        claude: {
          windows: [
            {
              windowKey: "session_5h", pct: 12, resetEpochMs: 9000,
              forecast: { predictedPctAtReset: 30, burnRatePctPerHour: 4, method: "history" },
            },
            {
              windowKey: "weekly_all", pct: 40, resetEpochMs: 20000,
              forecast: { predictedPctAtReset: 70, burnRatePctPerHour: 0.3, method: "window-linear" },
            },
          ],
        },
      },
    }));
    const snap = readQuotaSnapshot(6000, path);
    expect(snap.guard.sessionPct).toBe(12);
    expect(snap.sessionForecast).toEqual({ predictedPctAtReset: 30, burnRatePctPerHour: 4, method: "history" });
    expect(snap.weeklyForecast).toEqual({ predictedPctAtReset: 70, burnRatePctPerHour: 0.3, method: "window-linear" });
  });

  it("defaults forecast to null when a window has none yet (fresh poll, no history)", () => {
    writeFileSync(path, JSON.stringify({
      generatedAtMs: 5000,
      providers: { claude: { windows: [{ windowKey: "session_5h", pct: 5, resetEpochMs: 9000, forecast: null }] } },
    }));
    const snap = readQuotaSnapshot(6000, path);
    expect(snap.sessionForecast).toBeNull();
    expect(snap.weeklyForecast).toBeNull();
  });
});
