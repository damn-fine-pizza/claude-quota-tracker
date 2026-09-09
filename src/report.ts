import { DB_PATH } from "./config.js";
import { overview } from "./dashboard-api.js";
import { exhaustionEpochMs } from "./forecast.js";
import { Store } from "./store.js";

function fmt(ms: number | null): string {
  if (ms == null) return "?";
  return new Date(ms).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

/** `llm-squeeze status [--json]` — current window usage + forecast + 7-day KPI. */
export function printStatus(argv: string[]): void {
  const asJson = argv.includes("--json");
  const store = new Store(DB_PATH);
  try {
    const ov = overview(store, Date.now());
    if (asJson) { console.log(JSON.stringify(ov, null, 2)); return; }
    if (ov.windows.length === 0) {
      console.log("No usage data yet — run `llm-squeeze poll` first.");
      return;
    }
    console.log(`Plan: ${ov.planName ?? "not set — set it in the dashboard Settings panel or config.json (plan.name)"}`);
    for (const w of ov.windows) {
      let fc = "";
      if (w.forecast && w.pct != null && w.resetEpochMs != null) {
        const eta = exhaustionEpochMs({
          nowMs: Date.now(), currentPct: w.pct,
          burnRatePctPerHour: w.forecast.burnRatePctPerHour, resetEpochMs: w.resetEpochMs,
        });
        fc = eta != null
          ? `→ 100% by ${fmt(eta)} `
          : `→ ~${Math.round(Math.min(100, w.forecast.predictedPctAtReset))}% by reset `;
      }
      console.log(`${w.label}: ${w.pct ?? "?"}%  ${fc}· resets ${fmt(w.resetEpochMs)}`);
    }
    console.log(
      `7d: $${ov.kpi.cost7d.toFixed(2)} · ${ov.kpi.tokens7d.toLocaleString()} tok · ` +
      `${ov.kpi.runs7d} runs   (${ov.scopeNote})`,
    );
  } finally {
    store.close();
  }
}

/**
 * `llm-squeeze hint [--threshold N]` — a one-line nudge when the session window is
 * filling (default ≥70%), else nothing. Designed for a UserPromptSubmit hook:
 * its stdout becomes context so Claude can proactively offer night scheduling.
 * Reads cached latest.json only (no claude call, no quota consumed).
 */
export function printHint(argv: string[]): void {
  const i = argv.indexOf("--threshold");
  const threshold = i !== -1 ? Number(argv[i + 1]) || 70 : 70;
  const store = new Store(DB_PATH);
  try {
    const ov = overview(store, Date.now());
    const s = ov.windows.find((w) => w.key === "session_5h");
    if (!s || s.pct == null || s.pct < threshold) return;
    const eta = s.exhaustionEpochMs != null ? ` (100% by ${fmt(s.exhaustionEpochMs)})` : "";
    console.log(
      `[quota] session window ${s.pct}%${eta} — for heavy or non-urgent work, ` +
      `consider scheduling it for the night window with \`llm-squeeze enqueue --night\`.`,
    );
  } finally {
    store.close();
  }
}

/** `llm-squeeze tasks [--json]` — the task queue and recent runs. */
export function printTasks(argv: string[]): void {
  const asJson = argv.includes("--json");
  const store = new Store(DB_PATH);
  try {
    const tasks = store.listTasks();
    if (asJson) { console.log(JSON.stringify(tasks, null, 2)); return; }
    if (tasks.length === 0) { console.log("No tasks enqueued."); return; }
    for (const t of tasks) {
      const p = t.prompt.replace(/\s+/g, " ").slice(0, 56);
      console.log(
        `#${t.id} [${t.status}] ${t.size}/${t.permissionClass}/${t.scheduledWindow} ` +
        `pri${t.priority} — ${p}`,
      );
    }
  } finally {
    store.close();
  }
}
