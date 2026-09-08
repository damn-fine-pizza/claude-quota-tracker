import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, type McpHttpConfig } from "./config.js";
import { autoOpenDashboardIfConfigured } from "./dashboard.js";
import { createMcpServer } from "./mcp/server.js";
import { isLoopbackHost } from "./platform.js";
import { PACKAGE_VERSION, PRODUCT_NAME } from "./version.js";

const MAX_BODY_BYTES = 1_000_000;
const startedAtMs = Date.now();

/** Host header values we accept for this bind — always includes common loopback aliases when binding to one. */
function allowedHostHeaders(host: string, port: number): Set<string> {
  const hosts = new Set([`${host}:${port}`]);
  if (isLoopbackHost(host)) {
    hosts.add(`127.0.0.1:${port}`);
    hosts.add(`localhost:${port}`);
    hosts.add(`[::1]:${port}`);
  }
  return hosts;
}

/** Most non-browser MCP clients never send Origin at all — only reject it when present and mismatched. */
function originAllowed(origin: string | undefined, allowedHosts: Set<string>): boolean {
  if (!origin) return true;
  try {
    return allowedHosts.has(new URL(origin).host);
  } catch {
    return false;
  }
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) { resolve(undefined); return; }
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export interface McpHttpHandle {
  url: string;
  port: number;
  close: () => Promise<void>;
}

/** `overrides` lets tests bind an ephemeral port (0) instead of the configured one. */
export async function startMcpHttpServer(overrides: Partial<McpHttpConfig> = {}): Promise<McpHttpHandle> {
  const { host, port, enabled } = { ...loadConfig().mcp.http, ...overrides };
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid mcp.http.port: ${port}`);
  }
  if (!enabled) {
    console.error("[mcp-http] note: mcp.http.enabled is false in config.json — starting anyway since `claude-quota mcp-http` was run directly.");
  }
  if (!isLoopbackHost(host)) {
    console.warn(`[mcp-http] WARNING: binding to non-loopback host "${host}" exposes this MCP server (including run_now) beyond localhost.`);
  }
  // Refined below once the actual bound port is known (port 0 means "pick one" — used by tests).
  let allowedHosts = allowedHostHeaders(host, port);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        name: PRODUCT_NAME,
        version: PACKAGE_VERSION,
        transport: "streamable-http",
        mcpProtocolVersion: LATEST_PROTOCOL_VERSION,
        pid: process.pid,
        uptimeSeconds: Math.round((Date.now() - startedAtMs) / 1000),
      });
      return;
    }

    if (url.pathname !== "/mcp") {
      sendJson(res, 404, { error: "not found" });
      return;
    }

    // No server-initiated messages to push: refuse the optional SSE-stream GET
    // before ever creating a transport, instead of leaving a stream open.
    if (req.method === "GET") {
      res.writeHead(405, { allow: "POST, DELETE", "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Method not allowed." } }));
      return;
    }

    const hostHeader = req.headers.host;
    if (!hostHeader || !allowedHosts.has(hostHeader)) {
      sendJson(res, 400, { error: "invalid Host header" });
      return;
    }
    if (!originAllowed(req.headers.origin, allowedHosts)) {
      sendJson(res, 403, { error: "origin not allowed" });
      return;
    }

    let parsedBody: unknown;
    try {
      parsedBody = await readBody(req);
    } catch (e) {
      sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: (e as Error).message } });
      return;
    }

    // Stateless mode: a fresh server+transport pair per request, per the SDK's
    // own recommended pattern (a Protocol instance connects to one transport only).
    const mcpServer = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void mcpServer.close();
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  });

  const actualPort = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : port);
    });
  });
  allowedHosts = allowedHostHeaders(host, actualPort);
  console.log(`[mcp-http] listening on http://${host}:${actualPort}/mcp (health: http://${host}:${actualPort}/health)`);
  void autoOpenDashboardIfConfigured();
  return {
    url: `http://${host}:${actualPort}`,
    port: actualPort,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startMcpHttpServer().catch((e) => { console.error(e); process.exitCode = 1; });
}
