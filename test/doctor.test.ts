import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { DoctorCheck, DoctorReport } from "../src/doctor.js";

// Isolated QUOTA_TRACKER_HOME + HOME, set before config.js/install.js is first
// imported by doctor.js — never the real ~/.quota-tracker, ~/.local/bin, or
// this repo's own dev data/.
const homeDir = mkdtempSync(join(tmpdir(), "qt-doctor-"));
process.env.QUOTA_TRACKER_HOME = homeDir;
process.env.HOME = homeDir;

const { formatDoctorReport, runDoctorChecks } = await import("../src/doctor.js");

// Real Claude CLI checks (when `claude` is on PATH) can take several seconds;
// run the full check set once and assert against the shared result rather
// than re-running it (slow, and re-invokes the real `claude` CLI) per test.
let report: DoctorReport;
beforeAll(async () => {
  report = await runDoctorChecks();
  return () => rmSync(homeDir, { recursive: true, force: true });
}, 30_000);

describe("runDoctorChecks", () => {
  it("runs every check against a fresh, isolated environment without throwing", () => {
    expect(report.checks.length).toBeGreaterThan(5);
    for (const check of report.checks) {
      expect(["ok", "warn", "fail"]).toContain(check.status);
      expect(check.category.length).toBeGreaterThan(0);
      expect(check.name.length).toBeGreaterThan(0);
    }
  });

  it("ok reflects the absence of any fail-status check", () => {
    expect(report.ok).toBe(!report.checks.some((c) => c.status === "fail"));
  });

  it("the MCP stdio check succeeds via the SDK's in-memory transport (no subprocess needed)", () => {
    const mcp = report.checks.find((c) => c.category === "mcp" && c.name === "stdio server");
    expect(mcp?.status).toBe("ok");
  });

  it("a missing/uninstalled runtime is reported as a warning, not a failure", () => {
    const launcher = report.checks.find((c) => c.name === "launcher");
    expect(launcher?.status).toBe("warn"); // quota install was never run against this scratch home
  });
});

describe("formatDoctorReport", () => {
  function check(status: DoctorCheck["status"]): DoctorCheck {
    return { category: "test", name: "n", status, detail: "d" };
  }

  it("reports OK when every check is ok or warn", () => {
    const report: DoctorReport = { ok: true, checks: [check("ok"), check("warn")] };
    expect(formatDoctorReport(report)).toContain("quota doctor: OK");
  });

  it("reports FAILED when any check failed", () => {
    const report: DoctorReport = { ok: false, checks: [check("ok"), check("fail")] };
    expect(formatDoctorReport(report)).toContain("quota doctor: FAILED");
  });
});
