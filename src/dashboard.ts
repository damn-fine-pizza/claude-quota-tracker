import { spawn } from "node:child_process";
import {
  existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { createServer, get, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DATA_DIR, DB_PATH, loadConfig, saveConfigPatch, type DashboardConfig, type PlanConfig,
} from "./config.js";
import * as api from "./dashboard-api.js";
import { DASHBOARD_HTML } from "./dashboard-html.js";
import { bool, loadPacingConfig, mergePacingPatch, obj, type PacingConfig } from "./pacing-config.js";
import { openBrowserUrl } from "./platform.js";
import { isSea } from "./sea.js";
import { Store } from "./store.js";
import { SchedulerMetaStore } from "./scheduler-meta.js";
import { TRIAGE } from "./tasks.js";

const LOCK_PATH = join(DATA_DIR, "dashboard.lock");
const DAY_MS = 24 * 60 * 60 * 1000;
interface Lock { pid: number; port: number; startedAtMs: number; token: string }

function readLock(): Lock | null { try { return JSON.parse(readFileSync(LOCK_PATH, "utf8")) as Lock; } catch { return null; } }
function writeLock(lock: Lock): void { const tmp = `${LOCK_PATH}.tmp`; writeFileSync(tmp, JSON.stringify(lock)); renameSync(tmp, LOCK_PATH); }
function probeHealthz(port: number, token: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = get({ host: "127.0.0.1", port, path: "/healthz", timeout: 400 }, (res) => {
      let body = ""; res.on("data", (c) => (body += c)); res.on("end", () => {
        try { const j = JSON.parse(body); resolve(j.ok === true && j.token === token); } catch { resolve(false); }
      });
    });
    req.on("error", () => resolve(false)); req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}
async function probeAlive(): Promise<number | null> { const lock = readLock(); if (!lock) return null; return (await probeHealthz(lock.port, lock.token)) ? lock.port : null; }
function openBrowser(port: number): void { openBrowserUrl(`http://127.0.0.1:${port}/`); }
function json(res: ServerResponse, code: number, body: unknown): void { const s = JSON.stringify(body); res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(s); }
function handleApi(store: Store, url: URL, res: ServerResponse): void {
  const nowMs = Date.now();
  const num = (k: string, d: number) => { const raw = url.searchParams.get(k); if (raw === null || raw === "") return d; const v = Number(raw); return Number.isFinite(v) ? v : d; };
  switch (url.pathname) {
    case "/api/overview": return json(res, 200, api.overview(store, nowMs));
    case "/api/models": return json(res, 200, api.models(store, num("from", nowMs - 7 * DAY_MS), num("to", nowMs)));
    case "/api/contrib": return json(res, 200, api.contrib(store, num("from", nowMs - 84 * DAY_MS), num("to", nowMs)));
    case "/api/timeseries": return json(res, 200, api.timeseries(store, nowMs));
    case "/api/estimates": return json(res, 200, api.estimates(store));
    case "/api/queue": return json(res, 200, api.queue(store));
    default: return json(res, 404, { error: "not found" });
  }
}
function hostIsLocal(req: IncomingMessage): boolean { const host = (req.headers.host ?? "").split(":")[0].toLowerCase(); return host === "" || host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1"; }

/** Dashboard always binds 127.0.0.1; only a request with a matching (or absent) Origin may write settings. */
export function originAllowed(origin: string | undefined, port: number): boolean {
  if (!origin) return true;
  try {
    const host = new URL(origin).host;
    return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
  } catch {
    return false;
  }
}

const MAX_SETTINGS_BODY_BYTES = 100_000;
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_SETTINGS_BODY_BYTES) { req.destroy(); reject(new Error("request body too large")); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

async function handleTaskApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const parts = url.pathname.split("/").filter(Boolean); const id = parts[2] ? Number(parts[2]) : null;
  const store = new Store(DB_PATH); const meta = new SchedulerMetaStore(DB_PATH);
  try {
    if (req.method === "GET" && id === null) return json(res, 200, store.listTasks().map((task) => ({ task, scheduling: meta.getOrDefault(task.id) })));
    const body = await readJsonBody(req) as Record<string, unknown>;
    if (req.method === "POST" && id === null) {
      const prompt = String(body.prompt ?? "").trim(); const cwd = String(body.cwd ?? "").trim();
      if (!prompt || !cwd) return json(res, 400, { error: "prompt and cwd are required" });
      const permission = (body.permission === "write-scoped" || body.permission === "destructive") ? body.permission : "read-only";
      const rule = TRIAGE[permission]; const now = Date.now();
      const task = store.enqueueTask(now, { prompt, cwd, size: (body.size as never) ?? "m", priority: Number(body.priority ?? 0), deferOk: true, permissionClass: permission, permissionMode: rule.permissionMode, unattendedOk: rule.unattendedOk, scheduledWindow: "night" });
      const scheduling = meta.upsert(task.id, now, { titleMarkdown: typeof body.title_markdown === "string" ? body.title_markdown : null, providerId: typeof body.provider === "string" ? body.provider : "claude", profileId: typeof body.profile === "string" ? body.profile : "claude-default", category: typeof body.category === "string" ? body.category : null, manualOrder: task.id });
      return json(res, 201, { task, scheduling });
    }
    if (id === null || !store.getTask(id)) return json(res, 404, { error: "task not found" });
    if (req.method === "DELETE") { const task = store.getTask(id)!; if (task.status === "running") return json(res, 409, { error: "task is running" }); meta.delete(id); return json(res, 200, { deleted: store.deleteTask(id), taskId: id }); }
    if (req.method === "PATCH") { const current = meta.getOrDefault(id); const scheduling = meta.upsert(id, Date.now(), { ...current, paused: typeof body.paused === "boolean" ? body.paused : current.paused, titleMarkdown: body.title_markdown === undefined ? current.titleMarkdown : (body.title_markdown as string | null), category: body.category === undefined ? current.category : (body.category as string | null), manualOrder: typeof body.manual_order === "number" ? body.manual_order : current.manualOrder, queueMode: body.queue_mode === "manual" ? "manual" : body.queue_mode === "priority" ? "priority" : current.queueMode }); return json(res, 200, { task: store.getTask(id), scheduling }); }
    return json(res, 405, { error: "method not allowed" });
  } catch (e) { return json(res, 400, { error: (e as Error).message }); } finally { meta.close(); store.close(); }
}

function mergeDashboardPatch(current: DashboardConfig, patch: unknown): DashboardConfig {
  const p = obj(patch);
  return { ...current, autoOpen: bool(p.autoOpen, current.autoOpen) };
}

/** `name` is free text (or null to clear it) — never gates any scheduling logic. */
function mergePlanPatch(current: PlanConfig, patch: unknown): PlanConfig {
  const p = obj(patch);
  if (!("name" in p)) return current;
  const v = p.name;
  if (v !== null && typeof v !== "string") throw new Error("plan.name must be a string or null");
  const trimmed = typeof v === "string" ? v.trim() : v;
  return { name: trimmed === "" ? null : trimmed };
}

export interface Settings { pacing: PacingConfig; dashboard: DashboardConfig; plan: PlanConfig }
export function currentSettings(): Settings {
  const cfg = loadConfig();
  return { pacing: loadPacingConfig(), dashboard: cfg.dashboard, plan: cfg.plan };
}
/** Applies only the sections present in the request body; sections omitted from the body are left untouched on disk. */
export function applySettingsPatch(body: unknown): Settings {
  const b = obj(body);
  const current = currentSettings();
  const next: Settings = { ...current };
  const patch: Partial<Record<"pacing" | "dashboard" | "plan", unknown>> = {};
  if ("pacing" in b) { next.pacing = mergePacingPatch(current.pacing, b.pacing); patch.pacing = next.pacing; }
  if ("dashboard" in b) { next.dashboard = mergeDashboardPatch(current.dashboard, b.dashboard); patch.dashboard = next.dashboard; }
  if ("plan" in b) { next.plan = mergePlanPatch(current.plan, b.plan); patch.plan = next.plan; }
  if (Object.keys(patch).length > 0) saveConfigPatch(patch);
  return next;
}
function startServer(port: number, token: string): void {
  const cfg = loadConfig(); mkdirSync(DATA_DIR, { recursive: true }); const startedAtMs = Date.now(); let lastReqMs = startedAtMs;
  const server = createServer((req, res) => {
    lastReqMs = Date.now(); if (!hostIsLocal(req)) return json(res, 403, { error: "forbidden host" });
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/settings") {
      if (req.method === "GET") return json(res, 200, currentSettings());
      if (req.method === "POST") {
        if (!originAllowed(req.headers.origin, port)) return json(res, 403, { error: "origin not allowed" });
        void (async () => {
          try {
            const body = await readJsonBody(req);
            json(res, 200, applySettingsPatch(body));
          } catch (e) {
            json(res, 400, { error: (e as Error).message });
          }
        })();
        return;
      }
      return json(res, 405, { error: "method not allowed" });
    }
    if (url.pathname === "/api/tasks" || url.pathname.startsWith("/api/tasks/")) {
      if (req.method !== "GET" && !originAllowed(req.headers.origin, port)) return json(res, 403, { error: "origin not allowed" });
      void handleTaskApi(req, res, url); return;
    }
    if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
    if (url.pathname === "/healthz") return json(res, 200, { ok: true, pid: process.pid, token, startedAtMs });
    if (url.pathname === "/") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); return res.end(DASHBOARD_HTML); }
    if (url.pathname.startsWith("/api/")) { const store = new Store(DB_PATH); try { handleApi(store, url, res); } catch (e) { json(res, 500, { error: String(e) }); } finally { store.close(); } return; }
    json(res, 404, { error: "not found" });
  });
  const tryListen = (p: number, attempt: number): void => {
    server.once("error", (e: NodeJS.ErrnoException) => { if (e.code === "EADDRINUSE" && attempt < 5) return tryListen(p + 1, attempt + 1); console.error("[dashboard] listen failed:", e); process.exit(1); });
    server.listen(p, "127.0.0.1", () => { writeLock({ pid: process.pid, port: p, startedAtMs: Date.now(), token }); console.log(`[dashboard] http://127.0.0.1:${p}/`); });
  };
  tryListen(port, 0);
  const cleanup = () => { const lock = readLock(); if (lock && lock.pid === process.pid) { try { unlinkSync(LOCK_PATH); } catch {} } };
  process.on("SIGINT", () => { cleanup(); process.exit(0); }); process.on("SIGTERM", () => { cleanup(); process.exit(0); }); process.on("exit", cleanup);
  if (cfg.dashboard.idleShutdownMin > 0) { const idleMs = cfg.dashboard.idleShutdownMin * 60 * 1000; setInterval(() => { if (Date.now() - lastReqMs > idleMs) { cleanup(); process.exit(0); } }, 30_000).unref(); }
}
const LAUNCH_LOCK = join(DATA_DIR, "dashboard.launching");
async function waitAndOpen(open: boolean): Promise<boolean> { for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 50)); const port = await probeAlive(); if (port !== null) { if (open) openBrowser(port); return true; } } return false; }
async function launch(open: boolean, onlyIfFresh = false): Promise<void> {
  const alive = await probeAlive(); if (alive !== null) { if (open && !onlyIfFresh) openBrowser(alive); return; } mkdirSync(DATA_DIR, { recursive: true });
  try { writeFileSync(LAUNCH_LOCK, String(process.pid), { flag: "wx" }); } catch { if (await waitAndOpen(open)) return; try { unlinkSync(LAUNCH_LOCK); } catch {} try { writeFileSync(LAUNCH_LOCK, String(process.pid), { flag: "wx" }); } catch { return; } }
  try {
    const args = isSea() ? ["dashboard", "--foreground"] : [join(dirname(fileURLToPath(import.meta.url)), "dashboard.js"), "--foreground"];
    const child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", "ignore", "ignore"] }); child.on("error", (e) => console.error("[dashboard] spawn failed:", e)); child.unref();
    if (!(await waitAndOpen(open))) { console.error("[dashboard] server did not come up in time"); process.exitCode = 1; }
  } finally { try { unlinkSync(LAUNCH_LOCK); } catch {} }
}
export async function dashboard(argv: string[]): Promise<void> { if (argv.includes("--foreground")) { const cfg = loadConfig(); startServer(cfg.dashboard.port, `${process.pid}-${Date.now()}`); return; } await launch(argv.includes("--open")); }
/** Called from quota mcp/mcp-http startup when config.dashboard.autoOpen is set. Only opens a browser tab for a freshly-spawned server — never re-opens one against an already-running dashboard, so a browser tab doesn't pop up on every MCP session. */
export async function autoOpenDashboardIfConfigured(): Promise<void> {
  try {
    if (!loadConfig().dashboard.autoOpen) return;
    await launch(true, true);
  } catch (e) {
    console.error("[dashboard] auto-open failed:", e);
  }
}
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) dashboard(process.argv.slice(2)).catch((e) => { console.error("[dashboard] fatal:", e); process.exitCode = 1; });
