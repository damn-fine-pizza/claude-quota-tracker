import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { INSTALL_SOURCE_PATH } from "./install.js";
import { PACKAGE_VERSION } from "./version.js";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type ExecFn = (bin: string, args: string[], opts?: { cwd?: string }) => Promise<ExecResult>;

const defaultExec: ExecFn = (bin, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(bin, args, { cwd: opts.cwd }, (err, stdout, stderr) => {
      const exitCode = err ? (typeof (err as NodeJS.ErrnoException).code === "number" ? (err as unknown as { code: number }).code : 1) : 0;
      resolve({ stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "", exitCode });
    });
  });

/**
 * Finds the git checkout this install came from: the marker install.ts writes
 * at install time, or (fallback, for pre-existing installs) the cwd itself
 * when it looks like this repo. Never guesses further than that.
 */
export function resolveSourceRepo(cwd: string = process.cwd()): string | null {
  try {
    const marker = JSON.parse(readFileSync(INSTALL_SOURCE_PATH, "utf8")) as { repoRoot?: string };
    if (marker.repoRoot && existsSync(join(marker.repoRoot, ".git"))) return marker.repoRoot;
  } catch {
    // no marker yet (pre-existing install) or unreadable
  }
  try {
    if (existsSync(join(cwd, ".git"))) {
      const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { name?: string };
      if (pkg.name === "quota-tracker") return cwd;
    }
  } catch {
    // cwd doesn't look like this repo
  }
  return null;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export interface UpdateCheckResult {
  ok: boolean;
  current: string;
  available?: string;
  updateAvailable?: boolean;
  message: string;
}

/** Read-only: never touches the filesystem, safe to call anytime. */
export async function checkForUpdate(fetchImpl: typeof fetch = fetch): Promise<UpdateCheckResult> {
  const current = PACKAGE_VERSION;
  const repo = loadConfig().update.repository;
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
      signal: AbortSignal.timeout(5000),
      headers: { accept: "application/vnd.github+json" },
    });
    if (res.status === 404) {
      return { ok: true, current, message: `current: ${current}\nno releases published yet on ${repo}` };
    }
    if (!res.ok) {
      return { ok: false, current, message: `current: ${current}\nGitHub API returned HTTP ${res.status}` };
    }
    const body = (await res.json()) as { tag_name?: string };
    const available = (body.tag_name ?? "").replace(/^v/, "");
    if (!available) {
      return { ok: false, current, message: `current: ${current}\ncould not determine the latest release tag` };
    }
    const updateAvailable = compareVersions(available, current) > 0;
    return {
      ok: true, current, available, updateAvailable,
      message: `current: ${current}\navailable: ${available}\nupdate available: ${updateAvailable ? "yes" : "no"}`,
    };
  } catch (e) {
    return { ok: false, current, message: `current: ${current}\nunable to check for updates: ${(e as Error).message}` };
  }
}

export interface UpdateResult {
  ok: boolean;
  message: string;
}

const MANUAL_FALLBACK = [
  "could not determine the source git checkout for this installation.",
  "update manually from your clone:",
  "  cd <your-clone> && git pull && npm ci && npm run build && node dist/cli.js install",
].join("\n");

/**
 * git fetch + pull --ff-only, then rebuild and re-run install() — never
 * resets/force-pushes/switches branches, and aborts outright on a dirty tree.
 */
export async function runUpdate(deps: { exec?: ExecFn; cwd?: string } = {}): Promise<UpdateResult> {
  const exec = deps.exec ?? defaultExec;
  const repoRoot = resolveSourceRepo(deps.cwd);
  if (!repoRoot) return { ok: false, message: MANUAL_FALLBACK };

  const status = await exec("git", ["status", "--porcelain"], { cwd: repoRoot });
  if (status.exitCode !== 0) {
    return { ok: false, message: `git status failed in ${repoRoot}: ${status.stderr.trim()}` };
  }
  if (status.stdout.trim() !== "") {
    return { ok: false, message: `working tree is dirty in ${repoRoot} — commit or stash your changes before updating.` };
  }

  const fetch_ = await exec("git", ["fetch", "origin"], { cwd: repoRoot });
  if (fetch_.exitCode !== 0) return { ok: false, message: `git fetch failed: ${fetch_.stderr.trim()}` };

  const pull = await exec("git", ["pull", "--ff-only"], { cwd: repoRoot });
  if (pull.exitCode !== 0) {
    return { ok: false, message: `git pull --ff-only failed (branch may have diverged locally): ${pull.stderr.trim()}` };
  }

  const ci = await exec("npm", ["ci"], { cwd: repoRoot });
  if (ci.exitCode !== 0) return { ok: false, message: `npm ci failed: ${ci.stderr.trim()}` };

  const build = await exec("npm", ["run", "build"], { cwd: repoRoot });
  if (build.exitCode !== 0) return { ok: false, message: `npm run build failed: ${build.stderr.trim()}` };

  const installRun = await exec(process.execPath, [join(repoRoot, "dist", "cli.js"), "install"], { cwd: repoRoot });
  if (installRun.exitCode !== 0) return { ok: false, message: `install refresh failed: ${installRun.stderr.trim()}` };

  return { ok: true, message: `updated ${repoRoot} and refreshed the installed runtime.\n${installRun.stdout.trim()}` };
}
