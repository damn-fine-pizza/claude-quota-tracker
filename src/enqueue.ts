import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { CONFIG_PATH, DB_PATH, loadConfig, saveConfigPatch } from "./config.js";
import { Store } from "./store.js";
import {
  confirmPhrase, currentTimezone, nightWindowConfirmPhrase, parseHHMMRange, TRIAGE,
} from "./tasks.js";
import { SIZE_ESTIMATES, type PermissionClass, type TaskSize } from "./types.js";

const SIZES: TaskSize[] = ["xs", "s", "m", "l", "xl"];
const CLASSES: PermissionClass[] = ["read-only", "write-scoped", "destructive"];

/**
 * write-scoped tasks run inside `git worktree add` (runner.ts); if the cwd
 * isn't a git work tree, that fails at execution time — possibly overnight.
 * Warn at enqueue so it's caught now, not at 2am.
 */
function warnIfNotGitWorktree(cls: PermissionClass, cwd: string): void {
  if (cls !== "write-scoped") return;
  try {
    execFileSync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], {
      stdio: "ignore",
    });
  } catch {
    console.warn(
      `⚠ warning: the working directory for this write-scoped task is not a git repository (${cwd}).\n` +
      `  git worktree isolation will fail at execution time. Pass a git repository path via --cwd.`,
    );
  }
}

/**
 * Line-queueing prompt reader. readline's question() drops lines that arrive
 * between questions on piped stdin (only a TTY paces input), which silently
 * kills scripted use — so buffer every line and answer questions in order.
 */
export function createAsker(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
) {
  const rl = createInterface({ input, output });
  const queue: string[] = [];
  const waiters: Array<(s: string) => void> = [];
  let closed = false;
  rl.on("line", (l) => {
    const w = waiters.shift();
    if (w) w(l);
    else queue.push(l);
  });
  rl.on("close", () => {
    closed = true;
    while (waiters.length > 0) waiters.shift()!("");
  });
  return {
    question(q: string): Promise<string> {
      output.write(q);
      const buffered = queue.shift();
      if (buffered !== undefined) return Promise.resolve(buffered);
      if (closed) return Promise.resolve("");
      return new Promise((res) => waiters.push(res));
    },
    close: () => rl.close(),
    isClosed: () => closed && queue.length === 0,
  };
}

export async function enqueueInteractive(): Promise<void> {
  const rl = createAsker();
  const ask = async (q: string, fallback?: string): Promise<string> => {
    const a = (await rl.question(q)).trim();
    return a || fallback || "";
  };

  try {
    const config = loadConfig();

    console.log("Prompt (end with a blank line):");
    const lines: string[] = [];
    for (;;) {
      const line = await rl.question("> ");
      if (!line.trim()) break;
      lines.push(line);
    }
    const prompt = lines.join("\n").trim();
    if (!prompt) {
      console.error("Prompt is empty — cancelling enqueue.");
      return;
    }

    const cwd = await ask(`Working directory [${process.cwd()}]: `, process.cwd());

    let size: TaskSize;
    for (;;) {
      const s = (await ask("Size (xs/s/m/l/xl): ")) as TaskSize;
      if (SIZES.includes(s)) { size = s; break; }
      if (rl.isClosed()) throw new Error("stdin closed before a valid size was given");
      console.log("Enter one of xs/s/m/l/xl.");
    }
    const est = SIZE_ESTIMATES[size];
    console.log(`  → estimated ~${Math.round(est.tokens / 1000)}K tokens / ~${est.minutes} min`);

    const priority = Number(await ask("Priority (higher runs first) [0]: ", "0")) || 0;
    const deferOk = (await ask("Can this defer to the night window? (Y/n): ", "y")).toLowerCase() !== "n";

    console.log("\nPermission triage — which of these is closest to what this task does?");
    CLASSES.forEach((c, i) => console.log(`  ${i + 1}) ${c.padEnd(13)} ${TRIAGE[c].summary}`));
    let cls: PermissionClass;
    for (;;) {
      const n = Number(await ask("Choice [1-3]: "));
      if (Number.isInteger(n) && n >= 1 && n <= 3) { cls = CLASSES[n - 1]; break; }
      if (rl.isClosed()) throw new Error("stdin closed before a valid triage choice was given");
    }
    const rule = TRIAGE[cls];
    warnIfNotGitWorktree(cls, cwd);

    console.log(`\n${confirmPhrase(cls, config.nightWindow)}`);
    if (rule.unattendedOk) {
      const yes = (await ask("Do you agree? (y/N): ")).toLowerCase() === "y";
      if (!yes) {
        console.log("Not agreed — cancelling enqueue.");
        return;
      }
    }

    const scheduledWindow = rule.unattendedOk && deferOk ? "night" : "any";

    // Night-slot task while the window is unconfirmed — or confirmed in a
    // different timezone (the gate refuses silently otherwise): confirm now.
    const tz = currentTimezone();
    const needsNightConfirm =
      scheduledWindow === "night" &&
      (!config.nightWindow.confirmedAt || config.nightWindow.confirmedTz !== tz);
    if (needsNightConfirm) {
      if (config.nightWindow.confirmedAt) {
        console.log(
          `\nTimezone changed (${config.nightWindow.confirmedTz} → ${tz}). Re-confirmation is required.`,
        );
      }
      console.log(`\n${nightWindowConfirmPhrase(config.nightWindow, tz)}`);
      const a = (await ask('(y=allow / n=hold / or type a range, e.g. "00:30-07:00"): ')).toLowerCase();
      let { start, end } = config.nightWindow;
      let confirmed = false;
      const range = parseHHMMRange(a);
      if (range) { ({ start, end } = range); confirmed = true; }
      else if (a === "y") confirmed = true;
      else if (a !== "n" && a !== "") {
        console.log('Could not parse that input ("HH:MM-HH:MM" or y/n) — treating as hold.');
      }
      if (confirmed) {
        saveConfigPatch(
          {
            nightWindow: {
              start, end,
              confirmedAt: new Date().toISOString(),
              confirmedTz: tz,
            },
          },
          CONFIG_PATH,
        );
        console.log(`→ night window ${start}–${end} (${tz}) confirmed and recorded`);
      } else {
        console.log("→ Held: the night batch will not run until confirmed (the task is still enqueued).");
      }
    }

    const store = new Store(DB_PATH);
    try {
      const task = store.enqueueTask(Date.now(), {
        prompt, cwd, size, priority, deferOk,
        permissionClass: cls,
        permissionMode: rule.permissionMode,
        unattendedOk: rule.unattendedOk,
        scheduledWindow,
      });
      console.log(
        `\n✓ task #${task.id} enqueued — ${size} / ${cls} / ${rule.permissionMode} / ` +
        `${scheduledWindow} slot / priority ${priority}`,
      );
      if (!rule.unattendedOk) {
        console.log(`  cannot run unattended — run: npm run executor -- --task ${task.id}`);
        console.log("  (manual runs still go through the same scheduler path, to accumulate estimation data)");
      }
    } finally {
      store.close();
    }
  } finally {
    rl.close();
  }
}

function parseFlags(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

/**
 * Non-interactive enqueue from flags:
 *   quota enqueue --prompt "..." --size xs --perm read-only [--night]
 *                 [--cwd PATH] [--priority N]
 * --night opts the task into unattended night execution (and records the
 * night-window confirmation, since the flag itself is the explicit opt-in).
 */
export function enqueueFromArgs(argv: string[]): void {
  const f = parseFlags(argv);
  const prompt = typeof f.prompt === "string" ? f.prompt.trim() : "";
  const size = f.size as TaskSize;
  const cls = f.perm as PermissionClass;
  if (!prompt) { console.error("--prompt <text> is required"); process.exitCode = 1; return; }
  if (!SIZES.includes(size)) { console.error("--size xs|s|m|l|xl is required"); process.exitCode = 1; return; }
  if (!CLASSES.includes(cls)) { console.error("--perm read-only|write-scoped|destructive is required"); process.exitCode = 1; return; }

  const cwd = typeof f.cwd === "string" ? f.cwd : process.cwd();
  const priority = typeof f.priority === "string" ? Number(f.priority) || 0 : 0;
  const wantNight = f.night === true || f.night === "true";
  const rule = TRIAGE[cls];
  warnIfNotGitWorktree(cls, cwd);

  let scheduledWindow: "night" | "any" = "any";
  let deferOk = false;
  if (wantNight) {
    if (!rule.unattendedOk) {
      console.warn(`warning: ${cls} cannot run unattended — ignoring --night, enqueuing to the 'any' slot (manual run)`);
    } else {
      scheduledWindow = "night";
      deferOk = true;
    }
  }

  const config = loadConfig();
  const tz = currentTimezone();
  if (
    scheduledWindow === "night" &&
    (!config.nightWindow.confirmedAt || config.nightWindow.confirmedTz !== tz)
  ) {
    saveConfigPatch(
      {
        nightWindow: {
          start: config.nightWindow.start, end: config.nightWindow.end,
          confirmedAt: new Date().toISOString(), confirmedTz: tz,
        },
      },
      CONFIG_PATH,
    );
    console.log(
      `→ night window ${config.nightWindow.start}–${config.nightWindow.end} (${tz}) auto-confirmed (--night)`,
    );
  }

  const store = new Store(DB_PATH);
  try {
    const task = store.enqueueTask(Date.now(), {
      prompt, cwd, size, priority, deferOk,
      permissionClass: cls, permissionMode: rule.permissionMode,
      unattendedOk: rule.unattendedOk, scheduledWindow,
    });
    console.log(
      `✓ task #${task.id} enqueued — ${size} / ${cls} / ${rule.permissionMode} / ` +
      `${scheduledWindow} slot / priority ${priority}`,
    );
    if (scheduledWindow === "night") {
      console.log("  will run automatically at the night window's lowest-usage hour (at the window start until enough data accumulates).");
    }
    if (!rule.unattendedOk) {
      console.log(`  cannot run unattended — run: quota executor --task ${task.id}`);
    }
  } finally {
    store.close();
  }
}

/** Route: flags present → non-interactive, otherwise the interactive prompt. */
export function enqueue(argv: string[]): Promise<void> | void {
  if (argv.length > 0) return enqueueFromArgs(argv);
  return enqueueInteractive();
}

const isMain = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  Promise.resolve(enqueue(process.argv.slice(2))).catch((e) => {
    console.error("[enqueue] failed:", e);
    process.exitCode = 1;
  });
}
