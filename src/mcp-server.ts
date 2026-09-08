import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { autoOpenDashboardIfConfigured } from "./dashboard.js";
import { createMcpServer } from "./mcp/server.js";

export async function startMcpServer(): Promise<void> {
  void autoOpenDashboardIfConfigured();
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startMcpServer().catch((e) => { console.error(e); process.exitCode = 1; });
}
