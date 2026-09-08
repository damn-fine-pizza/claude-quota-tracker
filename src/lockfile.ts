import { readFileSync, unlinkSync, writeFileSync } from "node:fs";

export function isPidAlive(pid: number | null): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** O_EXCL lockfile with stale-holder takeover: two attempts, second wins if the first holder's pid is dead. */
export function acquireLock(lockPath: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockPath, String(process.pid), { flag: "wx" });
      return true;
    } catch {
      try {
        const holder = Number(readFileSync(lockPath, "utf8"));
        if (isPidAlive(holder)) return false;
        unlinkSync(lockPath); // stale lock from a dead holder
      } catch {
        return false;
      }
    }
  }
  return false;
}

export function releaseLock(lockPath: string): void {
  try {
    if (Number(readFileSync(lockPath, "utf8")) === process.pid) unlinkSync(lockPath);
  } catch {
    // already gone
  }
}
