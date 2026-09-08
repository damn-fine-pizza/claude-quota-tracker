import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CLAUDE_PROJECTS_DIR, CONFIG_PATH, DATA_DIR, DB_PATH, loadConfig, PROJECT_ROOT } from "./config.js";
import { APP_HOME, commandWorks, LAUNCHER, systemdUsable } from "./install.js";
import { createMcpServer } from "./mcp/server.js";
import { detectContainerEnvironment, isLoopbackHost, normalizePlatform } from "./platform.js";
import { ClaudeProvider } from "./providers/claude.js";
import { Store } from "./store.js";
import { PACKAGE_VERSION, PRODUCT_NAME } from "./version.js";

export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  category: string;
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

async function checkMcpStdio(): Promise<string> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer();
  const client = new Client({ name: "quota-doctor", version: PACKAGE_VERSION });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    return `${tools.length} tools registered`;
  } finally {
    await client.close();
    await server.close();
  }
}

export async function runDoctorChecks(): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const push = (category: string, name: string, status: CheckStatus, detail: string) =>
    checks.push({ category, name, status, detail });

  const [major, minor] = process.versions.node.split(".").map(Number);
  const nodeOk = major > 22 || (major === 22 && minor >= 5);
  push("runtime", "node version", nodeOk ? "ok" : "fail", `Node ${process.versions.node} (need >=22.5)`);

  push("runtime", "home directory", existsSync(PROJECT_ROOT) ? "ok" : "warn", PROJECT_ROOT);

  try {
    if (existsSync(CONFIG_PATH)) {
      JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
      push("runtime", "config", "ok", `${CONFIG_PATH} (parsed ok)`);
    } else {
      push("runtime", "config", "ok", `${CONFIG_PATH} (missing — defaults apply)`);
    }
  } catch (e) {
    push("runtime", "config", "fail", `${CONFIG_PATH}: ${(e as Error).message}`);
  }

  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const store = new Store(DB_PATH);
    store.close();
    push("runtime", "sqlite db", "ok", DB_PATH);
  } catch (e) {
    push("runtime", "sqlite db", "fail", `${DB_PATH}: ${(e as Error).message}`);
  }

  const installedCli = join(APP_HOME, "lib", "dist", "cli.js");
  push(
    "runtime", "installed runtime",
    existsSync(installedCli) ? "ok" : "warn",
    existsSync(installedCli) ? installedCli : `not found at ${installedCli} — run \`quota install\``,
  );
  push(
    "runtime", "launcher",
    existsSync(LAUNCHER) ? "ok" : "warn",
    existsSync(LAUNCHER) ? LAUNCHER : `not found at ${LAUNCHER} — run \`quota install\``,
  );

  if (!commandWorks("claude", ["--version"])) {
    push("claude", "claude CLI", "warn", "`claude` not found on PATH");
  } else {
    try {
      const windows = await new ClaudeProvider().fetch();
      push("claude", "claude CLI", "ok", "`claude -p \"/usage\"` executed");
      push("claude", "quota snapshot", windows.length > 0 ? "ok" : "warn", `${windows.length} usage window(s) parsed`);
    } catch (e) {
      push("claude", "claude CLI", "warn", (e as Error).message);
    }
  }
  push("claude", "session directory", existsSync(CLAUDE_PROJECTS_DIR) ? "ok" : "warn", CLAUDE_PROJECTS_DIR);

  const gitOk = commandWorks("git", ["--version"]);
  push("git", "git", gitOk ? "ok" : "fail", gitOk ? "available" : "`git` not found on PATH");
  if (gitOk) {
    const worktreeOk = commandWorks("git", ["worktree", "--help"]);
    push("git", "git worktree", worktreeOk ? "ok" : "warn", worktreeOk ? "supported" : "`git worktree` unavailable");
  }

  try {
    const detail = await checkMcpStdio();
    push("mcp", "stdio server", "ok", detail);
  } catch (e) {
    push("mcp", "stdio server", "fail", (e as Error).message);
  }

  const config = loadConfig();
  const http = config.mcp.http;
  const portValid = Number.isInteger(http.port) && http.port > 0 && http.port <= 65535;
  push("mcp", "http config", portValid ? "ok" : "fail", `host=${http.host} port=${http.port} enabled=${http.enabled}`);
  if (portValid && !isLoopbackHost(http.host)) {
    push("mcp", "http bind", "warn", `configured host "${http.host}" is not loopback-only`);
  }
  if (portValid) {
    try {
      const res = await fetch(`http://${http.host}:${http.port}/health`, { signal: AbortSignal.timeout(1000) });
      const body = (await res.json().catch(() => null)) as { name?: string; pid?: number; version?: string } | null;
      if (res.ok && body?.name === PRODUCT_NAME) {
        push("mcp", "http port", "ok", `already running (pid ${body.pid}, v${body.version})`);
      } else {
        push("mcp", "http port", "warn", `port ${http.port} is occupied by a non-quota-tracker service`);
      }
    } catch {
      push("mcp", "http port", "ok", `port ${http.port} is free`);
    }
  }

  const platform = normalizePlatform();
  if (platform === "darwin") {
    push("desktop", "launchctl", commandWorks("launchctl", ["version"]) ? "ok" : "warn", "used for the poller LaunchAgent");
    push("desktop", "osascript", commandWorks("osascript", ["-e", "1"]) ? "ok" : "warn", "used for notifications");
    push("desktop", "open", commandWorks("open", ["--help"]) ? "ok" : "warn", "used to open the dashboard");
    const swiftBar = existsSync("/Applications/SwiftBar.app") || existsSync(join(homedir(), "Applications", "SwiftBar.app"));
    push("desktop", "SwiftBar", swiftBar ? "ok" : "warn", swiftBar ? "installed" : "optional, not installed");
  } else if (platform === "linux") {
    push("desktop", "xdg-open", commandWorks("xdg-open", ["--version"]) ? "ok" : "warn", "used to open the dashboard");
    push("desktop", "notify-send", commandWorks("notify-send", ["--version"]) ? "ok" : "warn", "used for notifications");
    const systemd = systemdUsable();
    push("scheduler", "systemd-user", systemd ? "ok" : "warn", systemd ? "available" : "unavailable");
    push("scheduler", "portable-daemon", "ok", "available via `quota daemon`");
  }

  if (detectContainerEnvironment()) {
    push(
      "container", "environment", "warn",
      "container/Distrobox-like environment detected — use `quota daemon` instead of systemd/launchd",
    );
  }

  return { ok: !checks.some((c) => c.status === "fail"), checks };
}

export function formatDoctorReport(report: DoctorReport): string {
  const icon: Record<CheckStatus, string> = { ok: "✓", warn: "⚠", fail: "✗" };
  const lines = report.checks.map((c) => `${icon[c.status]} [${c.category}] ${c.name}: ${c.detail}`);
  lines.push("", report.ok ? "quota doctor: OK" : "quota doctor: FAILED (see ✗ above)");
  return lines.join("\n");
}
