import { CONFIG_PATH, DATA_DIR } from "./config.js";
import { dashboard } from "./dashboard.js";
import { runDaemon } from "./daemon.js";
import { enqueue } from "./enqueue.js";
import { runManualTask, runNightLoop } from "./executor.js";
import { install, uninstall } from "./install.js";
import { renderMenubar } from "./menubar.js";
import { pollOnce } from "./poller.js";
import { printHint, printStatus, printTasks } from "./report.js";
import { runPacedOnce } from "./paced-executor.js";
import { getRuntimeInfo } from "./version.js";

const HELP = `claude-quota — Claude quota tracker & quota-aware task orchestrator

Usage:
  claude-quota install            install launcher + native scheduler when available
  claude-quota uninstall          remove native scheduler integration (data preserved)
  claude-quota daemon             portable polling loop (no systemd/launchd required)
  claude-quota poll               poll usage once
  claude-quota executor           legacy night queue loop
  claude-quota paced-executor     quota-aware admission + at most one task
  claude-quota executor --task N  run task N manually (hard quota guards preserved)
  claude-quota enqueue            interactive task registration
  claude-quota mcp                start MCP stdio server
  claude-quota mcp-http           start MCP Streamable HTTP server (127.0.0.1:47601/mcp)
  claude-quota version [--json]   runtime/version info
  claude-quota doctor [--json]    diagnose install, MCP, scheduler, platform integration
  claude-quota update [--check]   update the installed runtime from a git checkout
  claude-quota status [--json]    current usage/forecast/KPI
  claude-quota tasks [--json]     task queue state
  claude-quota hint [--threshold N]
  claude-quota menubar            SwiftBar output (macOS)
  claude-quota dashboard [--open] local dashboard
  claude-quota ingest             ingest Claude Code session logs
  claude-quota paths              print config/data paths
`;

function checkNodeVersion(): boolean {
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj < 22 || (maj === 22 && min < 5)) {
    console.error(`claude-quota requires Node 22.5+ (current: ${process.versions.node})`);
    return false;
  }
  return true;
}

export async function main(argv: string[]): Promise<void> {
  if (!checkNodeVersion()) { process.exitCode = 1; return; }
  const cmd = argv[0];
  switch (cmd) {
    case "poll": {
      const latest = await pollOnce();
      const n = Object.values(latest.providers).reduce((s, p) => s + p.windows.length, 0);
      console.log(`[claude-quota-tracker] polled ${n} window readings`);
      return;
    }
    case "daemon":
      return runDaemon();
    case "executor": {
      const taskFlag = argv.indexOf("--task");
      if (taskFlag !== -1) {
        const result = await runManualTask(Number(argv[taskFlag + 1]));
        process.exitCode = result.ok ? 0 : 1;
      } else await runNightLoop();
      return;
    }
    case "paced-executor": {
      const ok = await runPacedOnce(); process.exitCode = ok ? 0 : 1; return;
    }
    case "mcp": {
      const { startMcpServer } = await import("./mcp-server.js");
      return startMcpServer();
    }
    case "mcp-http": {
      const { startMcpHttpServer } = await import("./mcp-http.js");
      await startMcpHttpServer();
      return;
    }
    case "version": {
      const info = getRuntimeInfo();
      if (argv.includes("--json")) { console.log(JSON.stringify(info, null, 2)); return; }
      console.log(`${info.name} ${info.version}`);
      console.log(`Node ${info.node}`);
      console.log(`Platform ${info.platform} ${info.arch}`);
      console.log("MCP stdio: supported");
      console.log("MCP HTTP: supported");
      return;
    }
    case "doctor": {
      const { formatDoctorReport, runDoctorChecks } = await import("./doctor.js");
      const report = await runDoctorChecks();
      console.log(argv.includes("--json") ? JSON.stringify(report, null, 2) : formatDoctorReport(report));
      process.exitCode = report.ok ? 0 : 1;
      return;
    }
    case "update": {
      const { checkForUpdate, runUpdate } = await import("./update.js");
      if (argv.includes("--check")) {
        const result = await checkForUpdate();
        console.log(result.message);
        return;
      }
      const result = await runUpdate();
      console.log(result.message);
      process.exitCode = result.ok ? 0 : 1;
      return;
    }
    case "install": return install();
    case "uninstall": return uninstall();
    case "enqueue": return enqueue(argv.slice(1));
    case "menubar": console.log(renderMenubar()); return;
    case "status": printStatus(argv.slice(1)); return;
    case "tasks": printTasks(argv.slice(1)); return;
    case "hint": printHint(argv.slice(1)); return;
    case "ingest": {
      const { ingestUsage } = await import("./ingest.js");
      const { Store } = await import("./store.js");
      const { DB_PATH } = await import("./config.js");
      const store = new Store(DB_PATH);
      try {
        const r = ingestUsage(store, Date.now());
        console.log(`[claude-quota-tracker] ingest: ${r.inserted} new events from ${r.scanned}/${r.files} files`);
      } finally { store.close(); }
      return;
    }
    case "dashboard": return dashboard(argv.slice(1));
    case "paths": console.log(`config: ${CONFIG_PATH}`); console.log(`data:   ${DATA_DIR}`); return;
    default:
      console.log(HELP);
      if (cmd && cmd !== "help" && cmd !== "--help") process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((e) => { console.error("[claude-quota-tracker] fatal:", e); process.exitCode = 1; });
