import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Isolated LLM_SQUEEZE_HOME, set before config.js/dashboard.js is first
// imported — never the real ~/.llm-squeeze.
const homeDir = mkdtempSync(join(tmpdir(), "qt-dashboard-settings-"));
process.env.LLM_SQUEEZE_HOME = homeDir;

const { applySettingsPatch, currentSettings, originAllowed } = await import("../src/dashboard.js");
const { CONFIG_PATH } = await import("../src/config.js");

afterAll(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

describe("currentSettings / applySettingsPatch", () => {
  it("falls back to defaults when config.json has no pacing/dashboard sections yet", () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({}));
    const s = currentSettings();
    expect(s.pacing.enabled).toBe(false);
    expect(s.dashboard.autoOpen).toBe(false);
    expect(s.dashboard.port).toBe(47600);
  });

  it("applies a pacing patch without touching the dashboard section", () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({
      pacing: { enabled: false, slackPct: 5, sessionWindowHours: 5, weeklyWindowHours: 168, continuousEnabled: false, deadlineSafetyMinutes: 15, adaptiveMinSamples: 3 },
      dashboard: { port: 47600, idleShutdownMin: 0, autoOpen: false },
    }));
    const next = applySettingsPatch({ pacing: { enabled: true, slackPct: 10 } });
    expect(next.pacing.enabled).toBe(true);
    expect(next.pacing.slackPct).toBe(10);
    // Unspecified pacing fields keep their CURRENT value, not the default.
    expect(next.pacing.sessionWindowHours).toBe(5);
    expect(next.dashboard.autoOpen).toBe(false);

    const onDisk = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    expect(onDisk.dashboard).toEqual({ port: 47600, idleShutdownMin: 0, autoOpen: false });
  });

  it("never wipes dashboard.port/idleShutdownMin when only autoOpen is patched", () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({
      dashboard: { port: 47777, idleShutdownMin: 15, autoOpen: false },
    }));
    const next = applySettingsPatch({ dashboard: { autoOpen: true } });
    expect(next.dashboard).toEqual({ port: 47777, idleShutdownMin: 15, autoOpen: true });
    const onDisk = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    expect(onDisk.dashboard).toEqual({ port: 47777, idleShutdownMin: 15, autoOpen: true });
  });

  it("leaves the file untouched when the patch has neither section", () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({ pollIntervalSeconds: 123 }));
    const before = readFileSync(CONFIG_PATH, "utf8");
    applySettingsPatch({});
    expect(readFileSync(CONFIG_PATH, "utf8")).toBe(before);
  });

  it("rejects an out-of-range or wrong-typed field instead of silently coercing it", () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({}));
    expect(() => applySettingsPatch({ pacing: { slackPct: "ten" } })).toThrow();
    expect(() => applySettingsPatch({ pacing: { adaptiveMinSamples: 0 } })).toThrow();
    expect(() => applySettingsPatch({ dashboard: { autoOpen: "yes" } })).toThrow();
  });

  it("defaults plan.name to null and lets it be set, trimmed, and cleared", () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({}));
    expect(currentSettings().plan.name).toBeNull();

    const withName = applySettingsPatch({ plan: { name: "  Max20  " } });
    expect(withName.plan.name).toBe("Max20");
    expect(JSON.parse(readFileSync(CONFIG_PATH, "utf8")).plan).toEqual({ name: "Max20" });

    const cleared = applySettingsPatch({ plan: { name: "" } });
    expect(cleared.plan.name).toBeNull();
  });

  it("rejects a non-string, non-null plan.name", () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({}));
    expect(() => applySettingsPatch({ plan: { name: 42 } })).toThrow();
  });

  it("leaves plan untouched when only pacing is patched", () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({ plan: { name: "Max20" } }));
    const next = applySettingsPatch({ pacing: { slackPct: 7 } });
    expect(next.plan.name).toBe("Max20");
  });
});

describe("originAllowed", () => {
  it("allows a request with no Origin header", () => {
    expect(originAllowed(undefined, 47600)).toBe(true);
  });
  it("allows a matching loopback origin", () => {
    expect(originAllowed("http://127.0.0.1:47600", 47600)).toBe(true);
    expect(originAllowed("http://localhost:47600", 47600)).toBe(true);
  });
  it("rejects a mismatched origin", () => {
    expect(originAllowed("http://evil.example.com", 47600)).toBe(false);
    expect(originAllowed("http://127.0.0.1:9999", 47600)).toBe(false);
  });
});
