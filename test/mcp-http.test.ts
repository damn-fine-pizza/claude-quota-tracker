import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

// LLM_SQUEEZE_HOME must be set before config.js (and anything importing it)
// is first evaluated, so every test in this file gets an isolated data dir —
// never the real ~/.llm-squeeze or this repo's own dev data/. vitest gives
// each test file its own module registry, so this only affects this file.
const homeDir = mkdtempSync(join(tmpdir(), "qt-mcp-http-"));
process.env.LLM_SQUEEZE_HOME = homeDir;

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
    expect(body.name).toBe("llm-squeeze");
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
    expect(initBody.result.serverInfo.name).toBe("llm-squeeze");

    const list = await rpc(server.url, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const listBody = (await readRpcJson(list)) as { result: { tools: Array<{ name: string }> } };
    const names = listBody.result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "delete_task", "get_pacing_status", "get_quota_status", "list_tasks",
      "pause_task", "preview_queue", "resume_task", "run_now", "run_queue", "set_pacing_config", "submit_task", "update_task",
    ]);

    const call = await rpc(server.url, {
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "get_quota_status", arguments: {} },
    });
    const callBody = (await readRpcJson(call)) as { result: { content: Array<{ type: string; text: string }> } };
    const payload = JSON.parse(callBody.result.content[0].text);
    expect(payload).toHaveProperty("hardGuard");
  });

  it("update_task changes priority and, separately, intent/deadline via one call", async () => {
    const submit = await rpc(server.url, {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "submit_task", arguments: { prompt: "p", cwd: "/tmp", priority: 0 } },
    });
    const submitBody = (await readRpcJson(submit)) as { result: { content: Array<{ text: string }> } };
    const taskId = JSON.parse(submitBody.result.content[0].text).task.id as number;

    const future = new Date(Date.now() + 60_000).toISOString();
    const update = await rpc(server.url, {
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "update_task", arguments: { task_id: taskId, priority: 42, intent: "deadline", deadline: future } },
    });
    const updateBody = (await readRpcJson(update)) as { result: { content: Array<{ text: string }> } };
    const payload = JSON.parse(updateBody.result.content[0].text);
    expect(payload.task.priority).toBe(42);
    expect(payload.scheduling.intent).toBe("deadline");
    expect(payload.scheduling.deadlineMs).toBe(Date.parse(future));
  });

  it("update_task never lets a destructive task become continuous-eligible", async () => {
    const submit = await rpc(server.url, {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "submit_task", arguments: { prompt: "p", cwd: "/tmp", permission: "destructive" } },
    });
    const submitBody = (await readRpcJson(submit)) as { result: { content: Array<{ text: string }> } };
    const taskId = JSON.parse(submitBody.result.content[0].text).task.id as number;

    const update = await rpc(server.url, {
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "update_task", arguments: { task_id: taskId, continuous: true } },
    });
    const updateBody = (await readRpcJson(update)) as { result: { content: Array<{ text: string }> } };
    const payload = JSON.parse(updateBody.result.content[0].text);
    expect(payload.scheduling.continuousOk).toBe(false);
  });

  it("update_task edits prompt/cwd/size, and separately re-triages permission (safely dropping continuousOk)", async () => {
    const submit = await rpc(server.url, {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "submit_task", arguments: { prompt: "old", cwd: "/old", permission: "write-scoped", continuous: true } },
    });
    const submitBody = (await readRpcJson(submit)) as { result: { content: Array<{ text: string }> } };
    const submitted = JSON.parse(submitBody.result.content[0].text);
    const taskId = submitted.task.id as number;
    expect(submitted.scheduling.continuousOk).toBe(true);

    const content = await rpc(server.url, {
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "update_task", arguments: { task_id: taskId, prompt: "new", cwd: "/new", size: "l" } },
    });
    const contentBody = (await readRpcJson(content)) as { result: { content: Array<{ text: string }> } };
    const afterContent = JSON.parse(contentBody.result.content[0].text);
    expect(afterContent.task.prompt).toBe("new");
    expect(afterContent.task.cwd).toBe("/new");
    expect(afterContent.task.size).toBe("l");
    expect(afterContent.scheduling.continuousOk).toBe(true); // permission untouched -> unaffected

    const rePermission = await rpc(server.url, {
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "update_task", arguments: { task_id: taskId, permission: "destructive" } },
    });
    const rePermissionBody = (await readRpcJson(rePermission)) as { result: { content: Array<{ text: string }> } };
    const afterPermission = JSON.parse(rePermissionBody.result.content[0].text);
    expect(afterPermission.task.permissionClass).toBe("destructive");
    // continuous wasn't passed this time either, but permission alone must still re-check eligibility.
    expect(afterPermission.scheduling.continuousOk).toBe(false);
  });

  it("delete_task removes a task from the queue", async () => {
    const submit = await rpc(server.url, {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "submit_task", arguments: { prompt: "p", cwd: "/tmp" } },
    });
    const submitBody = (await readRpcJson(submit)) as { result: { content: Array<{ text: string }> } };
    const taskId = JSON.parse(submitBody.result.content[0].text).task.id as number;

    const del = await rpc(server.url, {
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "delete_task", arguments: { task_id: taskId } },
    });
    const delBody = (await readRpcJson(del)) as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(delBody.result.content[0].text)).toEqual({ deleted: true, taskId });

    const list = await rpc(server.url, {
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "list_tasks", arguments: {} },
    });
    const listBody = (await readRpcJson(list)) as { result: { content: Array<{ text: string }> } };
    const tasks = JSON.parse(listBody.result.content[0].text) as Array<{ task: { id: number } }>;
    expect(tasks.some((t) => t.task.id === taskId)).toBe(false);
  });

  it("set_pacing_config patches only the given fields and get_pacing_status reflects it", async () => {
    const set = await rpc(server.url, {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "set_pacing_config", arguments: { enabled: true, slackPct: 12 } },
    });
    const setBody = (await readRpcJson(set)) as { result: { content: Array<{ text: string }> } };
    const pacing = JSON.parse(setBody.result.content[0].text);
    expect(pacing.enabled).toBe(true);
    expect(pacing.slackPct).toBe(12);
    expect(pacing.sessionWindowHours).toBe(5); // untouched field keeps its default/current value

    const status = await rpc(server.url, {
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "get_pacing_status", arguments: {} },
    });
    const statusBody = (await readRpcJson(status)) as { result: { content: Array<{ text: string }> } };
    const statusPayload = JSON.parse(statusBody.result.content[0].text);
    expect(statusPayload.config.enabled).toBe(true);
    expect(statusPayload.config.slackPct).toBe(12);
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
