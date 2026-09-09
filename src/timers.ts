import { DatabaseSync } from "node:sqlite";
import { DB_PATH } from "./config.js";
export type TimerKind = "timestamp" | "cron";
export interface Timer { id: number; kind: TimerKind; expression: string; taskId: number | null; paused: boolean; createdTs: number; updatedTs: number; }
export class TimerStore {
  private db: DatabaseSync;
  constructor(path = DB_PATH) { this.db = new DatabaseSync(path); this.db.exec("CREATE TABLE IF NOT EXISTS timers (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL CHECK(kind IN ('timestamp','cron')), expression TEXT NOT NULL, task_id INTEGER, paused INTEGER NOT NULL DEFAULT 0, created_ts INTEGER NOT NULL, updated_ts INTEGER NOT NULL)"); }
  list(): Timer[] { return this.db.prepare("SELECT * FROM timers ORDER BY id").all().map((r: any) => ({ id:r.id, kind:r.kind, expression:r.expression, taskId:r.task_id ?? null, paused:r.paused===1, createdTs:r.created_ts, updatedTs:r.updated_ts })); }
  add(kind: TimerKind, expression: string, taskId: number | null, now=Date.now()): Timer { const r:any=this.db.prepare("INSERT INTO timers(kind,expression,task_id,created_ts,updated_ts) VALUES(?,?,?,?,?) RETURNING *").get(kind,expression,taskId,now,now); return { id:r.id,kind:r.kind,expression:r.expression,taskId:r.task_id??null,paused:false,createdTs:r.created_ts,updatedTs:r.updated_ts }; }
  update(id: number, patch: Partial<Pick<Timer, "kind" | "expression" | "taskId" | "paused">>, now=Date.now()): Timer | null { const old=this.list().find(t=>t.id===id); if(!old)return null; const next={...old,...patch}; const r:any=this.db.prepare("UPDATE timers SET kind=?,expression=?,task_id=?,paused=?,updated_ts=? WHERE id=? RETURNING *").get(next.kind,next.expression,next.taskId,next.paused?1:0,now,id); return {id:r.id,kind:r.kind,expression:r.expression,taskId:r.task_id??null,paused:r.paused===1,createdTs:r.created_ts,updatedTs:r.updated_ts}; }
  cancel(id: number): boolean { return this.db.prepare("DELETE FROM timers WHERE id=?").run(id).changes > 0; }
  close(): void { this.db.close(); }
}
