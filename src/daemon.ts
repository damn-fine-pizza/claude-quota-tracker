import { join } from "node:path";
import { DATA_DIR, loadConfig } from "./config.js";
import { acquireLock, releaseLock } from "./lockfile.js";
import { pollOnce } from "./poller.js";

const LOCK_PATH = join(DATA_DIR, "daemon.lock");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Portable scheduler loop for environments without launchd/systemd (containers,
 * Distrobox, minimal Linux sessions). Polling remains one-shot in pollOnce();
 * this process only supplies the repeating clock. `signal` is an extra,
 * in-process stop trigger alongside SIGINT/SIGTERM — mainly for tests, which
 * can abort a controller instead of sending a real OS signal to the runner.
 */
export async function runDaemon(opts: { signal?: AbortSignal } = {}): Promise<void> {
  if (!acquireLock(LOCK_PATH)) {
    console.error("[llm-squeeze] another daemon instance holds the lock; exiting");
    process.exitCode = 1;
    return;
  }
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  opts.signal?.addEventListener("abort", stop);

  console.log(`[llm-squeeze] portable daemon started (pid ${process.pid})`);
  try {
    while (!stopping) {
      const started = Date.now();
      try {
        await pollOnce(started);
      } catch (e) {
        console.error("[llm-squeeze] daemon poll failed:", e);
      }
      const intervalMs = Math.max(10, loadConfig().pollIntervalSeconds) * 1000;
      const remaining = Math.max(0, intervalMs - (Date.now() - started));
      if (!stopping) await sleep(remaining);
    }
    console.log("[llm-squeeze] portable daemon stopped");
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    opts.signal?.removeEventListener("abort", stop);
    releaseLock(LOCK_PATH);
  }
}
