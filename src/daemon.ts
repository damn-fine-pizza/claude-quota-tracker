import { join } from "node:path";
import { DATA_DIR, loadConfig } from "./config.js";
import { acquireLock, releaseLock } from "./lockfile.js";
import { pollOnce } from "./poller.js";

const LOCK_PATH = join(DATA_DIR, "daemon.lock");

let stopping = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Portable scheduler loop for environments without launchd/systemd (containers,
 * Distrobox, minimal Linux sessions). Polling remains one-shot in pollOnce();
 * this process only supplies the repeating clock.
 */
export async function runDaemon(): Promise<void> {
  if (!acquireLock(LOCK_PATH)) {
    console.error("[quota-tracker] another daemon instance holds the lock; exiting");
    process.exitCode = 1;
    return;
  }
  const stop = () => { stopping = true; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  console.log(`[quota-tracker] portable daemon started (pid ${process.pid})`);
  try {
    while (!stopping) {
      const started = Date.now();
      try {
        await pollOnce(started);
      } catch (e) {
        console.error("[quota-tracker] daemon poll failed:", e);
      }
      const intervalMs = Math.max(10, loadConfig().pollIntervalSeconds) * 1000;
      const remaining = Math.max(0, intervalMs - (Date.now() - started));
      if (!stopping) await sleep(remaining);
    }
    console.log("[quota-tracker] portable daemon stopped");
  } finally {
    releaseLock(LOCK_PATH);
  }
}
