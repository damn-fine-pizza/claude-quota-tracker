import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { acquireLock, releaseLock } from "../src/lockfile.js";

// Isolated LLM_SQUEEZE_HOME, set before config.js is first imported — never
// the real ~/.llm-squeeze or this repo's own dev data/. A real pollOnce()
// (and so a real `claude -p "/usage"` call, when `claude` is on PATH) is
// unavoidable here since runDaemon always polls once immediately; kept to
// exactly one invocation across this file.
const homeDir = mkdtempSync(join(tmpdir(), "qt-daemon-"));
process.env.LLM_SQUEEZE_HOME = homeDir;

const { runDaemon } = await import("../src/daemon.js");
const { DATA_DIR } = await import("../src/config.js");
mkdirSync(DATA_DIR, { recursive: true });

afterAll(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

const LOCK_PATH = join(DATA_DIR, "daemon.lock");

describe("runDaemon single-instance lock", () => {
  it("refuses to start a second instance while the lock is held (no polling attempted)", async () => {
    expect(acquireLock(LOCK_PATH)).toBe(true);
    try {
      process.exitCode = undefined;
      await runDaemon();
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = undefined;
      releaseLock(LOCK_PATH);
    }
  });

  it("holds the lock while running and releases it once stopped", async () => {
    expect(existsSync(LOCK_PATH)).toBe(false);
    const controller = new AbortController();
    const done = runDaemon({ signal: controller.signal });
    controller.abort(); // cooperative: takes effect after the in-flight poll completes
    await done;
    expect(existsSync(LOCK_PATH)).toBe(false);
  }, 30_000);
});
