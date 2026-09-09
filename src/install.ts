import { execFileSync } from "node:child_process";
import {
  chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG, saveConfigPatch } from "./config.js";
import { normalizePlatform } from "./platform.js";
import { CLI_NAME } from "./version.js";

const LABEL = "com.llm-squeeze.poller";
export const APP_HOME = process.env.LLM_SQUEEZE_HOME ?? join(homedir(), ".llm-squeeze");
const APP_DATA = join(APP_HOME, "data");
const APP_CONFIG = join(APP_HOME, "config.json");
const APP_PLUGINS = join(APP_HOME, "plugins");
const LIB_DIR = join(APP_HOME, "lib");
const LIB_DIST = join(LIB_DIR, "dist");
export const LAUNCHER = join(homedir(), ".local", "bin", CLI_NAME);
const SYSTEMD_USER_DIR = join(homedir(), ".config", "systemd", "user");
const SYSTEMD_SERVICE = join(SYSTEMD_USER_DIR, "llm-squeeze.service");
const SYSTEMD_TIMER = join(SYSTEMD_USER_DIR, "llm-squeeze.timer");

function plistPath(label: string = LABEL): string { return join(homedir(), "Library", "LaunchAgents", `${label}.plist`); }
function run(bin: string, args: string[], opts: { allowFail?: boolean; cwd?: string } = {}): string {
  try { return execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd: opts.cwd }); }
  catch (e) { if (opts.allowFail) return ""; throw e; }
}
export function commandWorks(bin: string, args: string[]): boolean { try { execFileSync(bin, args, { stdio: "ignore" }); return true; } catch { return false; } }
function resolveNodePath(): string {
  for (const p of ["/opt/homebrew/bin/node", "/usr/local/bin/node"]) if (existsSync(p)) return p;
  return process.execPath;
}
export const INSTALL_SOURCE_PATH = join(APP_HOME, "install-source.json");

function recordInstallSource(srcDist: string): void {
  const repoRoot = dirname(srcDist);
  if (!existsSync(join(repoRoot, ".git"))) return;
  writeFileSync(INSTALL_SOURCE_PATH, JSON.stringify({ repoRoot, installedAt: new Date().toISOString() }, null, 2) + "\n");
}

export function installRuntime(nodePath: string, deps: { npmBin?: string; srcDist?: string } = {}): void {
  const srcDist = deps.srcDist ?? dirname(fileURLToPath(import.meta.url));
  if (resolve(srcDist) !== resolve(LIB_DIST)) {
    const repoRoot = dirname(srcDist);
    const staging = `${LIB_DIR}.staging`;
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    cpSync(srcDist, join(staging, "dist"), { recursive: true });

    const pkgPath = join(repoRoot, "package.json");
    const lockPath = join(repoRoot, "package-lock.json");
    if (existsSync(pkgPath) && existsSync(lockPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { dependencies?: Record<string, string> };
      if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
        copyFileSync(pkgPath, join(staging, "package.json"));
        copyFileSync(lockPath, join(staging, "package-lock.json"));
        // Runtime deps (e.g. the MCP SDK) live next to dist/, mirroring the repo
        // layout, so Node's resolution finds them from the installed cli.js too —
        // staged first so a failed/offline npm ci never clobbers a working install.
        run(deps.npmBin ?? "npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: staging });
        console.log(`✓ runtime dependencies → ${join(staging, "node_modules")}`);
      }
    }

    rmSync(LIB_DIR, { recursive: true, force: true });
    renameSync(staging, LIB_DIR);
    console.log(`✓ runtime → ${LIB_DIST}`);
    recordInstallSource(srcDist);
  }
  mkdirSync(dirname(LAUNCHER), { recursive: true });
  writeFileSync(LAUNCHER, `#!/bin/sh\nexport LLM_SQUEEZE_HOME="\${LLM_SQUEEZE_HOME:-$HOME/.llm-squeeze}"\nexec "${nodePath}" "${join(LIB_DIST, "cli.js")}" "$@"\n`);
  chmodSync(LAUNCHER, 0o755); console.log(`✓ launcher → ${LAUNCHER}`);
}
function installHome(): void {
  mkdirSync(APP_DATA, { recursive: true });
  if (!existsSync(APP_CONFIG)) { saveConfigPatch({ ...DEFAULT_CONFIG }, APP_CONFIG); console.log(`✓ default config → ${APP_CONFIG}`); }
}
function removeAgent(label: string): void {
  const uid = process.getuid?.(); if (uid === undefined) return;
  run("launchctl", ["bootout", `gui/${uid}/${label}`], { allowFail: true }); run("rm", ["-f", plistPath(label)], { allowFail: true });
}
function installLaunchd(nodePath: string): void {
  mkdirSync(dirname(plistPath()), { recursive: true });
  const env = `${join(homedir(), ".local", "bin")}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
  writeFileSync(plistPath(), `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${LABEL}</string>\n<key>ProgramArguments</key><array><string>${nodePath}</string><string>${join(LIB_DIST, "cli.js")}</string><string>poll</string></array>\n<key>EnvironmentVariables</key><dict><key>PATH</key><string>${env}</string><key>LLM_SQUEEZE_HOME</key><string>${APP_HOME}</string></dict>\n<key>StartInterval</key><integer>300</integer><key>RunAtLoad</key><true/>\n<key>StandardOutPath</key><string>${join(APP_DATA, "poller.log")}</string><key>StandardErrorPath</key><string>${join(APP_DATA, "poller.err.log")}</string>\n</dict></plist>\n`);
  const uid = process.getuid!(); run("launchctl", ["bootout", `gui/${uid}/${LABEL}`], { allowFail: true }); run("launchctl", ["bootstrap", `gui/${uid}`, plistPath()]);
  console.log("✓ launchd poller installed");
}
export function systemdUsable(): boolean {
  return commandWorks("systemctl", ["--user", "show-environment"]);
}
function installSystemd(): boolean {
  if (!systemdUsable()) return false;
  mkdirSync(SYSTEMD_USER_DIR, { recursive: true });
  writeFileSync(SYSTEMD_SERVICE, `[Unit]\nDescription=LLM Squeeze quota poll\n\n[Service]\nType=oneshot\nEnvironment=LLM_SQUEEZE_HOME=${APP_HOME}\nExecStart=${LAUNCHER} poll\n`);
  writeFileSync(SYSTEMD_TIMER, `[Unit]\nDescription=Poll Claude quota every 5 minutes\n\n[Timer]\nOnBootSec=1min\nOnUnitActiveSec=5min\nPersistent=true\nUnit=llm-squeeze.service\n\n[Install]\nWantedBy=timers.target\n`);
  run("systemctl", ["--user", "daemon-reload"]); run("systemctl", ["--user", "enable", "--now", "llm-squeeze.timer"]);
  console.log("✓ systemd --user timer installed"); return true;
}
function uninstallSystemd(): void {
  if (commandWorks("systemctl", ["--user", "show-environment"])) {
    run("systemctl", ["--user", "disable", "--now", "llm-squeeze.timer"], { allowFail: true });
    run("systemctl", ["--user", "daemon-reload"], { allowFail: true });
  }
  rmSync(SYSTEMD_SERVICE, { force: true }); rmSync(SYSTEMD_TIMER, { force: true });
}
function installSwiftBar(): void {
  const pluginDir = APP_PLUGINS; mkdirSync(pluginDir, { recursive: true }); const plugin = join(pluginDir, "usage.1m.sh");
  writeFileSync(plugin, `#!/bin/bash\nexec "${LAUNCHER}" menubar\n`); chmodSync(plugin, 0o755);
  const appInstalled = existsSync("/Applications/SwiftBar.app") || existsSync(join(homedir(), "Applications", "SwiftBar.app"));
  if (!appInstalled) return;
  const current = run("defaults", ["read", "com.ameba.SwiftBar", "PluginDirectory"], { allowFail: true }).trim();
  if (!current) run("defaults", ["write", "com.ameba.SwiftBar", "PluginDirectory", pluginDir]);
  else if (resolve(current) !== resolve(pluginDir)) { const link = join(current, "usage.1m.sh"); if (!existsSync(link)) copyFileSync(plugin, link); chmodSync(link, 0o755); }
}

export async function install(deps: { npmBin?: string; srcDist?: string } = {}): Promise<void> {
  const nodePath = resolveNodePath(); installRuntime(nodePath, deps); installHome();
  const platform = normalizePlatform();
  if (platform === "darwin") { installLaunchd(nodePath); installSwiftBar(); }
  else if (platform === "linux") {
    if (!installSystemd()) {
      console.log("⚠ systemd --user unavailable; install completed without a background scheduler.");
      console.log(`  Run \`${CLI_NAME} daemon\` in any long-lived shell/supervisor (works in Distrobox/containers/no-init environments). `);
    }
  } else {
    console.log(`⚠ no native scheduler integration for this platform; use \`${CLI_NAME} daemon\`.`);
  }
  console.log(`✓ config: ${APP_CONFIG}`);
}

export async function uninstall(): Promise<void> {
  const platform = normalizePlatform();
  if (platform === "darwin") removeAgent(LABEL);
  if (platform === "linux") uninstallSystemd();
  console.log(`Data preserved: ${APP_HOME}`);
  console.log(`Remove runtime manually: rm ${LAUNCHER}; rm -rf ${join(APP_HOME, "lib")}`);
}
