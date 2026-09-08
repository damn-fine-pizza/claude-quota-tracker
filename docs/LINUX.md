# Linux support

`quota-tracker` supports Linux with two scheduler modes.

## Linux with systemd --user

`claude-quota install` installs the launcher/runtime and, when `systemctl --user` is usable, creates and enables:

- `~/.config/systemd/user/claude-quota-tracker.service`
- `~/.config/systemd/user/claude-quota-tracker.timer`

The timer runs `claude-quota poll` every five minutes.

## Linux without systemd

Containers, Distrobox/minimal environments, remote shells, and other no-init sessions are supported through the portable daemon:

```bash
claude-quota daemon
```

or from a source checkout:

```bash
npm run build
npm run daemon
```

The daemon performs the same repeated `pollOnce()` operation using `pollIntervalSeconds` from config. It is suitable for any external supervisor (`tmux`, `screen`, container supervisor, cron wrapper, etc.). `claude-quota install` does **not** fail when systemd is unavailable; it installs the runtime and prints the daemon fallback command. Only one `claude-quota daemon` instance runs at a time — a second one refuses to start (and says so) instead of double-polling the same queue.

If you also want the local Streamable HTTP MCP transport, it's the same story — a separate foreground process, no systemd required:

```bash
claude-quota mcp-http
```

See [`MCP_HTTP.md`](MCP_HTTP.md).

## Containers / Distrobox

`claude-quota doctor` detects a container/Distrobox-like environment (via
`/run/.containerenv`, `/.dockerenv`, or `$container`) and, when found,
recommends `claude-quota daemon` instead of treating the missing init system as an
error — a container is a supported environment here, not a broken one.

```bash
claude-quota doctor    # confirms what's available in this environment
claude-quota daemon     # portable scheduler, foreground
claude-quota mcp-http   # HTTP MCP transport, foreground, separate process
```

## Desktop integration

- macOS notifications: `osascript`
- Linux notifications: `notify-send` when installed; absence is non-fatal
- macOS browser opener: `open`
- Linux browser opener: `xdg-open` when installed; absence is non-fatal
- SwiftBar remains macOS-only and is skipped on Linux

The MCP server (both stdio and HTTP transports), quota tracking, SQLite queue, pacing governor, task executor, and dashboard HTTP server do not require systemd. Run `claude-quota doctor` any time to see exactly what's available and what isn't in the current environment — a missing systemd session is always a warning, never a failure.
