import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "./types.js";
export interface PreflightResult { ok: boolean; reasons: string[]; }
/** Deterministic, model-free checks performed before a task can be claimed. */
export function preflightTask(task: Task): PreflightResult {
  const reasons: string[] = [];
  if (!existsSync(task.cwd)) reasons.push("cwd_missing");
  if (task.permissionClass === "write-scoped" && !existsSync(join(task.cwd, ".git"))) reasons.push("worktree_requires_git");
  if (!task.prompt.trim()) reasons.push("prompt_empty");
  return { ok: reasons.length === 0, reasons };
}
