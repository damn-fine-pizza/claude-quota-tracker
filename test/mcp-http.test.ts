import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

// QUOTA_TRACKER_HOME must be set before config.js (and anything importing it)
// is first evaluated, so every test in this file gets an isolated data dir —
// never the real ~/.quota-tracker or this repo's own dev data/. vitest gives
// each test file its own module registry, so this only affects this file.
const homeDir = mkdtempSync(join(tmpdir(), "qt-mcp-http-"));
process.env.QUOTA_TRACKER_HOME = homeDir;

const { startMcpHttpServer } = await import("../src/mcp-http.js");
type McpHttpHandle = Awaited<ReturnType<typeof startMcpHttpServer>>;

afterAll(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

async function rpc(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return res;
}

async function readRpcJson(res: Response): Promise<unknown> {
  // The SDK may answer as a single SSE "message" event even for a one-shot
  // stateless call; unwrap the `data: ` line if so, else parse as plain JSON.
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(line ? line.slice("data: ".length) : text);
}

describe("mcp-http", () => {
  let server: McpHttpHandle;

  beforeEach(async () => {
    server = await startMcpHttpServer({ host: "127.0.0.1", port: 0, enabled: true });
  });

  afterEach(async () => {
    await server.close();
  });

  it("GET /health reports name/version/transport", async () => {
    const res = await fetch(`${server.url}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.name).toBe("claude-quota-tracker");
    expect(body.transport).toBe("streamable-http");
    expect(typeof body.pid).toBe("number");
    expect(typeof body.mcpProtocolVersion).toBe("string");
  });

  it("runs a real initialize -> tools/list -> get_quota_status session", async () => {
    const init = await rpc(server.url, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0.0.1" } },
    });
    expect(init.status).toBe(200);
    const initBody = (await readRpcJson(init)) as { result: { serverInfo: { name: string; version: string } } };
    expect(initBody.result.serverInfo.name).toBe("claude-quota-tracker");

    const list = await rpc(server.url, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const listBody = (await readRpcJson(list)) as { result: { tools: Array<{ name: string }> } };
    const names = listBody.result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "get_pacing_status", "get_quota_status", "list_tasks",
      "pause_task", "resume_task", "run_now", "submit_task",
    ]);

    const call = await rpc(server.url, {
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "get_quota_status", arguments: {} },
    });
    const callBody = (await readRpcJson(call)) as { result: { content: Array<{ type: string; text: string }> } };
    const payload = JSON.parse(callBody.result.content[0].text);
    expect(payload).toHaveProperty("hardGuard");
  });

  it("rejects a mismatched Origin with 403 before reaching the MCP layer", async () => {
    const res = await rpc(server.url, { jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "http://evil.example.com" });
    expect(res.status).toBe(403);
  });

  it("allows a request with no Origin header (typical non-browser MCP client)", async () => {
    const res = await rpc(server.url, { jsonrpc: "2.0", id: 1, method: "ping" });
    expect(res.status).toBe(200);
  });

  it("GET /mcp returns 405 instead of opening an SSE stream", async () => {
    const res = await fetch(`${server.url}/mcp`, {
      headers: { accept: "text/event-stream" },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toContain("POST");
  });

  it("returns a clean error for an invalid JSON body instead of crashing", async () => {
    const res = await fetch(`${server.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: "not json",
    });
    expect(res.status).toBe(400);
    // The server must still be alive for the next request.
    const health = await fetch(`${server.url}/health`);
    expect(health.status).toBe(200);
  });

  it("binds to loopback only (127.0.0.1), not 0.0.0.0", () => {
    expect(server.url).toContain("127.0.0.1");
  });
});
