import { DatabaseSync } from "node:sqlite";
import { DB_PATH } from "./config.js";

export type SchedulingIntent = "interactive" | "deadline" | "opportunistic";
export type QueueMode = "manual" | "priority";

export interface TaskScheduleMeta {
  taskId: number;
  intent: SchedulingIntent;
  deadlineMs: number | null;
  estimatedTokens: number | null;
  paused: boolean;
  continuousOk: boolean;
  titleMarkdown: string | null;
  providerId: string;
  profileId: string;
  model: string | null;
  category: string | null;
  manualOrder: number;
  queueMode: QueueMode;
  createdTs: number;
  updatedTs: number;
}

export interface TaskScheduleMetaInput {
  intent?: SchedulingIntent;
  deadlineMs?: number | null;
  estimatedTokens?: number | null;
  paused?: boolean;
  continuousOk?: boolean;
  titleMarkdown?: string | null;
  providerId?: string;
  profileId?: string;
  model?: string | null;
  category?: string | null;
  manualOrder?: number;
  queueMode?: QueueMode;
}

export class SchedulerMetaStore {
  private db: DatabaseSync;

  constructor(path: string = DB_PATH) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_schedule_meta (
        task_id           INTEGER PRIMARY KEY REFERENCES tasks(id),
        intent            TEXT NOT NULL DEFAULT 'opportunistic'
                          CHECK (intent IN ('interactive','deadline','opportunistic')),
        deadline_ms       INTEGER,
        estimated_tokens  INTEGER,
        paused            INTEGER NOT NULL DEFAULT 0,
        continuous_ok     INTEGER NOT NULL DEFAULT 0,
        created_ts        INTEGER NOT NULL,
        updated_ts        INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_task_schedule_deadline
        ON task_schedule_meta (paused, intent, deadline_ms);
      CREATE TABLE IF NOT EXISTS planner_receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, task_id INTEGER NOT NULL,
        provider_id TEXT NOT NULL, profile_id TEXT NOT NULL, estimate_tokens INTEGER NOT NULL,
        policy TEXT NOT NULL, reason_code TEXT NOT NULL, budget_snapshot TEXT NOT NULL
      );
    `);
    for (const sql of [
      "ALTER TABLE task_schedule_meta ADD COLUMN title_markdown TEXT",
      "ALTER TABLE task_schedule_meta ADD COLUMN provider_id TEXT NOT NULL DEFAULT 'claude'",
      "ALTER TABLE task_schedule_meta ADD COLUMN profile_id TEXT NOT NULL DEFAULT 'claude-default'",
      "ALTER TABLE task_schedule_meta ADD COLUMN model TEXT",
      "ALTER TABLE task_schedule_meta ADD COLUMN category TEXT",
      "ALTER TABLE task_schedule_meta ADD COLUMN manual_order INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE task_schedule_meta ADD COLUMN queue_mode TEXT NOT NULL DEFAULT 'priority'",
    ]) { try { this.db.exec(sql); } catch { /* already migrated */ } }
  }

  private row(r: Record<string, unknown>): TaskScheduleMeta {
    return {
      taskId: r.task_id as number,
      intent: r.intent as SchedulingIntent,
      deadlineMs: (r.deadline_ms as number | null) ?? null,
      estimatedTokens: (r.estimated_tokens as number | null) ?? null,
      paused: r.paused === 1,
      continuousOk: r.continuous_ok === 1,
      titleMarkdown: (r.title_markdown as string | null) ?? null,
      providerId: (r.provider_id as string) ?? "claude",
      profileId: (r.profile_id as string) ?? "claude-default",
      model: (r.model as string | null) ?? null,
      category: (r.category as string | null) ?? null,
      manualOrder: (r.manual_order as number) ?? 0,
      queueMode: ((r.queue_mode as QueueMode) ?? "priority"),
      createdTs: r.created_ts as number,
      updatedTs: r.updated_ts as number,
    };
  }

  get(taskId: number): TaskScheduleMeta | null {
    const r = this.db.prepare("SELECT * FROM task_schedule_meta WHERE task_id = ?")
      .get(taskId) as Record<string, unknown> | undefined;
    return r ? this.row(r) : null;
  }

  getOrDefault(taskId: number): TaskScheduleMeta {
    return this.get(taskId) ?? {
      taskId,
      intent: "opportunistic",
      deadlineMs: null,
      estimatedTokens: null,
      paused: false,
      continuousOk: false,
      titleMarkdown: null, providerId: "claude", profileId: "claude-default", model: null,
      category: null, manualOrder: 0, queueMode: "priority",
      createdTs: 0,
      updatedTs: 0,
    };
  }

  upsert(taskId: number, nowMs: number, input: TaskScheduleMetaInput): TaskScheduleMeta {
    const intent = input.intent ?? "opportunistic";
    if (intent === "deadline" && input.deadlineMs == null) {
      throw new Error("deadline intent requires deadlineMs");
    }
    const r = this.db.prepare(`
      INSERT INTO task_schedule_meta
        (task_id, intent, deadline_ms, estimated_tokens, paused, continuous_ok, title_markdown, provider_id, profile_id, model, category, manual_order, queue_mode, created_ts, updated_ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        intent=excluded.intent,
        deadline_ms=excluded.deadline_ms,
        estimated_tokens=excluded.estimated_tokens,
        paused=excluded.paused,
        continuous_ok=excluded.continuous_ok,
        title_markdown=excluded.title_markdown, provider_id=excluded.provider_id, profile_id=excluded.profile_id,
        model=excluded.model, category=excluded.category, manual_order=excluded.manual_order, queue_mode=excluded.queue_mode,
        updated_ts=excluded.updated_ts
      RETURNING *
    `).get(
      taskId, intent, input.deadlineMs ?? null, input.estimatedTokens ?? null,
      input.paused ? 1 : 0, input.continuousOk ? 1 : 0,
      input.titleMarkdown ?? null, input.providerId ?? "claude", input.profileId ?? "claude-default",
      input.model ?? null, input.category ?? null, input.manualOrder ?? 0, input.queueMode ?? "priority", nowMs, nowMs,
    ) as Record<string, unknown>;
    return this.row(r);
  }

  setPaused(taskId: number, paused: boolean, nowMs: number): TaskScheduleMeta {
    const current = this.getOrDefault(taskId);
    return this.upsert(taskId, nowMs, { ...current, paused });
  }

  delete(taskId: number): void {
    this.db.prepare("DELETE FROM task_schedule_meta WHERE task_id = ?").run(taskId);
  }

  list(): TaskScheduleMeta[] {
    const rows = this.db.prepare(
      "SELECT * FROM task_schedule_meta ORDER BY updated_ts DESC",
    ).all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.row(r));
  }

  recordReceipt(args: { ts: number; taskId: number; providerId: string; profileId: string; estimateTokens: number; policy: string; reasonCode: string; budgetSnapshot: unknown }): void {
    this.db.prepare("INSERT INTO planner_receipts (ts, task_id, provider_id, profile_id, estimate_tokens, policy, reason_code, budget_snapshot) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(args.ts, args.taskId, args.providerId, args.profileId, args.estimateTokens, args.policy, args.reasonCode, JSON.stringify(args.budgetSnapshot));
  }

  close(): void { this.db.close(); }
}
