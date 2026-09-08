import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PACKAGE_VERSION, PRODUCT_NAME } from "../version.js";
import { registerTools } from "./tools.js";

export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: PRODUCT_NAME, version: PACKAGE_VERSION },
    { capabilities: { tools: { listChanged: false } } },
  );
  registerTools(server);
  return server;
}
