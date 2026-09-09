# MCP quota scheduler

The fork exposes the quota-aware scheduler over stdio MCP.

## Enable pacing

Copy `config.example.json` to your active config and enable, or use the
dashboard's **Settings** panel (`claude-quota dashboard --open`) to edit
these fields without touching any file:

```json
{
  "pacing": {
    "enabled": true,
    "slackPct": 5,
    "sessionWindowHours": 5,
    "weeklyWindowHours": 168,
    "continuousEnabled": true,
    "deadlineSafetyMinutes": 15,
    "adaptiveMinSamples": 3
  }
}
```

`enabled` turns on quota pacing. `continuousEnabled` allows tasks that were **explicitly** submitted with `continuous: true` to run outside the confirmed night window.

Hard guards in `executor.sessionGuardPct` and `executor.weeklyGuardPct` remain authoritative and are never bypassed by pacing, deadlines, or `run_now`.

## MCP configuration

After `npm run build`, start the server with:

```bash
npm run mcp
```

or, when using the installed/baked CLI:

```bash
claude-quota mcp
```

Example `.mcp.json` entry:

```json
{
  "mcpServers": {
    "claude-quota-tracker": {
      "command": "claude-quota",
      "args": ["mcp"]
    }
  }
}
```

or via the CLI, once, at user scope so it's available in every project:

```bash
claude mcp add claude-quota-tracker --scope user -- claude-quota mcp
```

Multiple MCP clients that want to share **one** running server instead of
each spawning their own `claude-quota mcp` process can use the local Streamable
HTTP transport (`claude-quota mcp-http`, `http://127.0.0.1:47601/mcp`) instead —
same tools, same authorization rules, see [`MCP_HTTP.md`](MCP_HTTP.md).

## Tools

### `submit_task`

Queues work and records scheduler metadata.

Important arguments:

- `prompt`: Claude Code task.
- `cwd`: repository/work directory.
- `size`: `xs|s|m|l|xl`.
- `intent`:
  - `interactive`: manual-only; pacing never delays a manual `run_now`.
  - `deadline`: obey pacing while there is time, then bypass pacing at the latest safe start.
  - `opportunistic`: only runs when both quota windows have paced capacity.
- `deadline`: required for `deadline`; ISO-8601 or epoch milliseconds.
- `permission`: `read-only|write-scoped|destructive`.
- `continuous`: explicit opt-in to unattended execution outside the night window. Ignored for `interactive` and destructive tasks.
- `estimated_tokens`: optional task-specific override for adaptive estimation.

### `get_quota_status`

Returns current 5-hour and weekly usage/reset values plus hard-guard status.

### `get_pacing_status`

Returns the ideal consumption target, allowed target including slack, and the binding window when work should be held.

### `set_pacing_config`

Updates one or more pacing fields (`enabled`, `slackPct`, `sessionWindowHours`, `weeklyWindowHours`, `continuousEnabled`, `deadlineSafetyMinutes`, `adaptiveMinSamples`) without touching config.json by hand. Only the provided fields change; the rest keep their current value. Also editable from the dashboard's Settings panel (`claude-quota dashboard --open`).

### `list_tasks`

Returns the existing queue plus scheduling intent/deadline/pause/continuous metadata.

### `pause_task` / `resume_task`

Temporarily remove/restore a task from automatic admission without changing the underlying queue lifecycle.

### `update_task`

Changes `prompt`, `cwd`, `size`, `permission`, `priority`, `intent`, `deadline`, and/or `continuous` on a task — for when a task's content needs correcting, or its priorities change after it's been sitting in the queue for a few days. Only the provided fields change. `prompt`/`cwd`/`size`/`permission` can only be edited on a `queued` or `carried_over` task (not `running`/`done`/`failed` — those already executed, or are executing, against the old content). Changing `permission` re-triages `permission_mode`/`unattendedOk` the same way `submit_task` does, and re-checks `continuousOk` even if `continuous` itself wasn't passed — so, e.g., re-triaging a task to `destructive` always drops continuous eligibility. Never lets a `destructive` task become continuous-eligible, regardless of what's requested (same rule `submit_task` enforces).

### `delete_task`

Permanently removes a task (and its run history) from the queue. Refuses to delete a currently-`running` task — wait for it to finish first. There is no undo; `pause_task` is the reversible alternative when you just want to stop a task from being picked up.

### `run_now`

Runs a specific queued task through the existing manual executor. Pacing is bypassed, but hard quota guards and Claude permission rules remain in force.

## Scheduling model

For each quota window, admission is gated on the poller's burn-rate forecast (see `forecast.ts`), not on cumulative usage against a fixed ideal curve:

```text
predicted usage at reset = current usage + (recent burn rate × remaining time)
on pace to exceed = predicted usage at reset > budget + slack
```

A queued opportunistic task starts only when both the 5-hour and weekly windows are **not** on pace to exceed their budget. The window furthest past its budget+slack threshold is the bottleneck.

This means cumulative usage alone never blocks work that is safely below the guard: if you burned 36% of the weekly budget on day one but the recent rate projects only 70% by the real reset, work keeps flowing — it only pauses once the *trend*, not the total-so-far, threatens to blow the guard before reset. `get_pacing_status` also reports `idealDailyPct` per window (remaining budget ÷ remaining time to reset) as a reference "how much can I still spend per day" figure, and the older elapsed-fraction `targetPct`/`allowedPct` fields as informational context — neither gates admission anymore.

The poller launches at most one paced task per fresh quota snapshot. It never drains multiple tasks using the same stale percentage reading.

## Adaptive estimation

Completed run history is grouped by task size. After `adaptiveMinSamples` successful runs, the scheduler uses the median token count plus a 15% safety margin instead of the static size estimate. Until enough data exists, static estimates remain the fallback. A task-specific `estimated_tokens` override wins over both.

Adaptive token estimates currently improve deadline latest-safe-start calculations. They intentionally do **not** pretend that Anthropic quota percentage is linearly convertible to token count.

## Continuous execution safety

Continuous execution requires all of:

1. global `pacing.continuousEnabled=true`;
2. explicit `continuous: true` on the task;
3. a permission class allowed unattended by the existing triage policy;
4. a non-interactive scheduling intent;
5. fresh quota data and passing hard guards.

`write-scoped` tasks still run in the existing isolated git worktree. `destructive` tasks remain manual-only.
