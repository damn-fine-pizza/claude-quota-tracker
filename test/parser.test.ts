import { describe, expect, it } from "vitest";
import { parseResetEpochMs, parseUsageOutput } from "../src/parser.js";

// 2026-06-11 09:00 Asia/Seoul = 2026-06-11T00:00:00Z
const NOW = Date.UTC(2026, 5, 11, 0, 0, 0);

const REAL_OUTPUT = `You are currently using your subscription to power your Claude Code usage

Current session: 12% used · resets Jun 11 at 10:49pm (Asia/Seoul)
Current week (all models): 16% used · resets Jun 13 at 10:59am (Asia/Seoul)
Current week (Sonnet only): 11% used · resets Jun 13 at 11am (Asia/Seoul)`;

describe("parseUsageOutput", () => {
  it("parses real captured /usage output into 3 windows", () => {
    const readings = parseUsageOutput(REAL_OUTPUT, NOW);
    expect(readings).toHaveLength(3);
    const byKey = Object.fromEntries(readings.map((r) => [r.windowKey, r]));
    expect(byKey.session_5h.pct).toBe(12);
    expect(byKey.session_5h).toMatchObject({
      name: "Session (5h)", unit: "percent", value: 12,
      source: "claude-cli-usage", reliability: "observed", durationMs: 5 * 60 * 60 * 1000,
    });
    expect(byKey.weekly_all.pct).toBe(16);
    expect(byKey.weekly_sonnet.pct).toBe(11);
    // Jun 11 22:49 KST = 13:49 UTC
    expect(byKey.session_5h.resetEpochMs).toBe(Date.UTC(2026, 5, 11, 13, 49));
    // Jun 13 10:59 KST = Jun 13 01:59 UTC
    expect(byKey.weekly_all.resetEpochMs).toBe(Date.UTC(2026, 5, 13, 1, 59));
    expect(byKey.session_5h.raw).toContain("Current session: 12% used");
  });

  it("handles minute-less times like '11am'", () => {
    const readings = parseUsageOutput(REAL_OUTPUT, NOW);
    const sonnet = readings.find((r) => r.windowKey === "weekly_sonnet")!;
    // Jun 13 11:00 KST = Jun 13 02:00 UTC
    expect(sonnet.resetEpochMs).toBe(Date.UTC(2026, 5, 13, 2, 0));
  });

  it("tolerates wording variations and decimal percents", () => {
    const out = `Session usage: 42.5% used · resets Jun 12 at 1:05am (Asia/Seoul)
Weekly limit (all models): 99% used · resets Jun 13 at 11am (Asia/Seoul)
Weekly (Sonnet only): 7% used · resets Jun 13 at 11am (Asia/Seoul)`;
    const readings = parseUsageOutput(out, NOW);
    const byKey = Object.fromEntries(readings.map((r) => [r.windowKey, r]));
    expect(byKey.session_5h.pct).toBe(42.5);
    expect(byKey.weekly_all.pct).toBe(99);
    expect(byKey.weekly_sonnet.pct).toBe(7);
  });

  it("keeps raw and yields null pct/reset when a window line is malformed", () => {
    const out = `Current session: limit reached, resets soon
Current week (all models): 16% used · resets Jun 13 at 10:59am (Asia/Seoul)`;
    const readings = parseUsageOutput(out, NOW);
    const session = readings.find((r) => r.windowKey === "session_5h")!;
    expect(session.pct).toBeNull();
    expect(session.resetEpochMs).toBeNull();
    expect(session.raw).toBe("Current session: limit reached, resets soon");
    expect(readings.find((r) => r.windowKey === "weekly_all")!.pct).toBe(16);
  });

  it("ignores unrelated lines and empty input", () => {
    expect(parseUsageOutput("", NOW)).toHaveLength(0);
    expect(
      parseUsageOutput("You are currently using your subscription\n\nblah", NOW),
    ).toHaveLength(0);
  });

  it("infers year across New Year boundary", () => {
    // now = Dec 31 2026 23:00 UTC; reset "Jan 1 at 3am" must land in 2027
    const now = Date.UTC(2026, 11, 31, 23, 0);
    const epoch = parseResetEpochMs(
      "Current session: 5% used · resets Jan 1 at 3am (UTC)", now,
    );
    expect(epoch).toBe(Date.UTC(2027, 0, 1, 3, 0));
  });

  it("falls back gracefully on unknown timezone", () => {
    const epoch = parseResetEpochMs(
      "Current session: 5% used · resets Jun 12 at 3pm (Mars/Olympus)", NOW,
    );
    expect(epoch).not.toBeNull(); // system-local fallback, still a valid epoch
  });

  it("parses the comma-separated day format with no 'at' (current CLI wording)", () => {
    // Observed 2026-09: "resets Sep 8, 9:20pm (Europe/Brussels)" — no "at",
    // comma after the day. The older "Jun 11 at 10:49pm" wording must keep working too.
    const out = `Current session: 97% used · resets Sep 8, 9:20pm (Europe/Brussels)
Current week (all models): 35% used · resets Sep 14, 8pm (Europe/Brussels)`;
    const readings = parseUsageOutput(out, Date.UTC(2026, 8, 8, 16, 22));
    const byKey = Object.fromEntries(readings.map((r) => [r.windowKey, r]));
    expect(byKey.session_5h.pct).toBe(97);
    expect(byKey.session_5h.resetEpochMs).not.toBeNull();
    // Sep 8 21:20 CEST (UTC+2) = Sep 8 19:20 UTC
    expect(byKey.session_5h.resetEpochMs).toBe(Date.UTC(2026, 8, 8, 19, 20));
    // Sep 14 20:00 CEST = Sep 14 18:00 UTC (no minutes given)
    expect(byKey.weekly_all.resetEpochMs).toBe(Date.UTC(2026, 8, 14, 18, 0));
  });
});
