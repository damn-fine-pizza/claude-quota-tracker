import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// Isolated LLM_SQUEEZE_HOME + HOME, set before install.js is first imported
// — never the real ~/.llm-squeeze or ~/.local/bin. installRuntime() alone
// is exercised here (not install()), so this never touches the real
// systemd/launchd session — only installRuntime is affected by this bug fix.
const homeDir = mkdtempSync(join(tmpdir(), "qt-install-home-"));
process.env.LLM_SQUEEZE_HOME = homeDir;
process.env.HOME = homeDir;

const { installRuntime } = await import("../src/install.js");

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

// A fake source checkout: dist/cli.js + package.json (with dependencies) +
// package-lock.json, mirroring the real repo layout installRuntime expects.
function fakeSourceRepo(): { repoRoot: string; srcDist: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), "qt-install-repo-"));
  dirs.push(repoRoot);
  const srcDist = join(repoRoot, "dist");
  mkdirSync(srcDist, { recursive: true });
  writeFileSync(join(srcDist, "cli.js"), "// fake compiled cli\n");
  writeFileSync(join(repoRoot, "package.json"), JSON.stringify({ dependencies: { "left-pad": "1.0.0" } }));
  writeFileSync(join(repoRoot, "package-lock.json"), "{}");
  return { repoRoot, srcDist };
}

// A fake `npm` that simulates `npm ci --omit=dev` by dropping a marker file
// into node_modules under its cwd — no real network/registry involved.
function fakeNpm(behavior: "succeed" | "fail"): string {
  const dir = mkdtempSync(join(tmpdir(), "qt-install-npm-"));
  dirs.push(dir);
  const script = join(dir, "npm");
  const body =
    behavior === "succeed"
      ? "#!/bin/sh\nmkdir -p node_modules\necho ok > node_modules/.materialized\n"
      : "#!/bin/sh\necho 'simulated npm ci failure' >&2\nexit 1\n";
  writeFileSync(script, body);
  chmodSync(script, 0o755);
  return script;
}

describe("installRuntime dependency materialization", () => {
  it("installs only the canonical llm-squeeze launcher", () => {
    const { repoRoot, srcDist } = fakeSourceRepo();
    writeFileSync(join(repoRoot, "package.json"), JSON.stringify({}));

    installRuntime("/usr/bin/node", { srcDist });

    const launcher = join(homeDir, ".local", "bin", "llm-squeeze");
    expect(existsSync(launcher)).toBe(true);
    expect(readFileSync(launcher, "utf8")).toContain("LLM_SQUEEZE_HOME");
    expect(readFileSync(launcher, "utf8")).toContain("/usr/bin/node");
    expect(readFileSync(launcher, "utf8")).not.toContain("LEGACY");
  });

  it("copies dist/, package files, and materializes production node_modules via the injected npm", () => {
    const { srcDist } = fakeSourceRepo();
    installRuntime("node", { npmBin: fakeNpm("succeed"), srcDist });

    const lib = join(homeDir, "lib");
    expect(existsSync(join(lib, "dist", "cli.js"))).toBe(true);
    expect(existsSync(join(lib, "package.json"))).toBe(true);
    expect(existsSync(join(lib, "package-lock.json"))).toBe(true);
    expect(readFileSync(join(lib, "node_modules", ".materialized"), "utf8")).toContain("ok");
  });

  it("never clobbers a working install when the injected npm fails", () => {
    const good = fakeSourceRepo();
    installRuntime("node", { npmBin: fakeNpm("succeed"), srcDist: good.srcDist });
    const lib = join(homeDir, "lib");
    expect(readFileSync(join(lib, "node_modules", ".materialized"), "utf8")).toContain("ok");

    const broken = fakeSourceRepo();
    expect(() => installRuntime("node", { npmBin: fakeNpm("fail"), srcDist: broken.srcDist })).toThrow();

    // The previous good install must be untouched — no half-swapped state.
    expect(readFileSync(join(lib, "node_modules", ".materialized"), "utf8")).toContain("ok");
    expect(existsSync(join(lib, "dist", "cli.js"))).toBe(true);
  });

  it("skips npm entirely when the source package.json has no dependencies", () => {
    const { repoRoot, srcDist } = fakeSourceRepo();
    writeFileSync(join(repoRoot, "package.json"), JSON.stringify({}));
    const dir = mkdtempSync(join(tmpdir(), "qt-install-npm-unused-"));
    dirs.push(dir);
    const script = join(dir, "npm");
    writeFileSync(script, "#!/bin/sh\ntouch invoked\nexit 0\n");
    chmodSync(script, 0o755);

    installRuntime("node", { npmBin: script, srcDist });
    expect(existsSync(join(dir, "invoked"))).toBe(false);
    expect(existsSync(join(homeDir, "lib", "node_modules"))).toBe(false);
  });
});
