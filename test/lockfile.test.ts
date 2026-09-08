import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireLock, isPidAlive, releaseLock } from "../src/lockfile.js";

const dirs: string[] = [];
function lockPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "qt-lockfile-"));
  dirs.push(dir);
  return join(dir, "test.lock");
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("acquireLock / releaseLock", () => {
  it("a fresh lock can be acquired", () => {
    const path = lockPath();
    expect(acquireLock(path)).toBe(true);
  });

  it("a second acquire fails while the first holder is alive", () => {
    const path = lockPath();
    expect(acquireLock(path)).toBe(true);
    expect(acquireLock(path)).toBe(false); // same process pid, so it's "alive" from the caller's own perspective too
  });

  it("release only removes the lock when the current pid owns it", () => {
    const path = lockPath();
    writeFileSync(path, "999999999"); // not our pid
    releaseLock(path);
    expect(existsSync(path)).toBe(true); // untouched — we don't own it
  });

  it("a stale lock from a dead pid is taken over", () => {
    const path = lockPath();
    writeFileSync(path, "999999999"); // very unlikely to be a live pid
    expect(acquireLock(path)).toBe(true);
  });

  it("release after a successful acquire frees the lock for the next caller", () => {
    const path = lockPath();
    expect(acquireLock(path)).toBe(true);
    releaseLock(path);
    expect(acquireLock(path)).toBe(true);
  });
});

describe("isPidAlive", () => {
  it("is true for the current process", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("is false for null and for an implausible pid", () => {
    expect(isPidAlive(null)).toBe(false);
    expect(isPidAlive(999999999)).toBe(false);
  });
});
