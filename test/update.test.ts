import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkForUpdate, resolveSourceRepo, runUpdate, type ExecFn, type ExecResult } from "../src/update.js";

const dirs: string[] = [];
function fakeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "qt-update-repo-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "quota-tracker" }));
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const ok: ExecResult = { stdout: "", stderr: "", exitCode: 0 };

describe("resolveSourceRepo", () => {
  it("uses cwd when it looks like this repo and no install marker exists", () => {
    const repo = fakeRepo();
    expect(resolveSourceRepo(repo)).toBe(repo);
  });

  it("returns null for a cwd that isn't a git checkout of this repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "qt-update-notrepo-"));
    dirs.push(dir);
    expect(resolveSourceRepo(dir)).toBeNull();
  });
});

describe("runUpdate", () => {
  it("aborts on a dirty working tree without running npm or the reinstall", async () => {
    const repo = fakeRepo();
    const calls: string[] = [];
    const exec: ExecFn = async (bin, args) => {
      calls.push(`${bin} ${args.join(" ")}`);
      if (bin === "git" && args[0] === "status") return { ...ok, stdout: " M src/cli.ts\n" };
      return ok;
    };
    const result = await runUpdate({ exec, cwd: repo });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("dirty");
    expect(calls).toEqual(["git status --porcelain"]);
  });

  it("clean tree runs the exact fetch -> pull -> npm ci -> npm build -> install sequence", async () => {
    const repo = fakeRepo();
    const calls: string[] = [];
    const exec: ExecFn = async (bin, args) => {
      calls.push(`${bin} ${args.join(" ")}`);
      return ok;
    };
    const result = await runUpdate({ exec, cwd: repo });
    expect(result.ok).toBe(true);
    expect(calls[0]).toBe("git status --porcelain");
    expect(calls[1]).toBe("git fetch origin");
    expect(calls[2]).toBe("git pull --ff-only");
    expect(calls[3]).toBe("npm ci");
    expect(calls[4]).toBe("npm run build");
    expect(calls[5]).toContain("dist/cli.js install");
  });

  it("stops after a non-fast-forward pull instead of continuing to npm/install", async () => {
    const repo = fakeRepo();
    const calls: string[] = [];
    const exec: ExecFn = async (bin, args) => {
      calls.push(`${bin} ${args.join(" ")}`);
      if (bin === "git" && args[0] === "pull") return { ...ok, exitCode: 1, stderr: "not possible to fast-forward" };
      return ok;
    };
    const result = await runUpdate({ exec, cwd: repo });
    expect(result.ok).toBe(false);
    expect(calls).toEqual(["git status --porcelain", "git fetch origin", "git pull --ff-only"]);
  });

  it("gives exact manual instructions when the source checkout cannot be resolved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qt-update-none-"));
    dirs.push(dir);
    const result = await runUpdate({ cwd: dir });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("git pull && npm ci && npm run build");
  });
});

describe("checkForUpdate", () => {
  it("reports update available when the remote release is newer", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ tag_name: "v99.0.0" }), { status: 200 })) as typeof fetch;
    const result = await checkForUpdate(fakeFetch);
    expect(result.ok).toBe(true);
    expect(result.available).toBe("99.0.0");
    expect(result.updateAvailable).toBe(true);
  });

  it("handles no releases published yet (404) without failing", async () => {
    const fakeFetch = (async () => new Response("", { status: 404 })) as typeof fetch;
    const result = await checkForUpdate(fakeFetch);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("no releases published yet");
  });

  it("is safe on a network failure — no throw, clean error message", async () => {
    const fakeFetch = (async () => { throw new Error("getaddrinfo ENOTFOUND api.github.com"); }) as typeof fetch;
    const result = await checkForUpdate(fakeFetch);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("unable to check for updates");
  });
});
