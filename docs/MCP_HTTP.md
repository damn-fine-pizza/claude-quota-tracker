# MCP over Streamable HTTP

`quota mcp` (stdio) still works exactly as before — this adds a second,
persistent transport so **multiple MCP clients can share one running server**
instead of each spawning its own `quota mcp` process. Both transports run the
same tool registry (`src/mcp/tools.ts`); nothing about the tools themselves
changes based on which one you use.

## Start the server

```bash
quota mcp-http
```

or, from a source checkout:

```bash
npm run build
npm run mcp-http
```

By default it binds to `127.0.0.1:47601` and serves:

- `POST /mcp` — the MCP Streamable HTTP endpoint (JSON-RPC 2.0)
- `GET /health` — health/version JSON, for scripts and `quota doctor`

`quota mcp-http` runs in the foreground. Use whatever supervisor fits your
setup — `systemd --user`, `tmux`/`screen`, a container supervisor, or nothing
at all if you just want it up for the current session.

## Client configuration

Verified against the current Claude Code MCP docs (`code.claude.com/docs/en/mcp`).

```json
{
  "mcpServers": {
    "quota-tracker-http": {
      "type": "http",
      "url": "http://127.0.0.1:47601/mcp"
    }
  }
}
```

or via the CLI:

```bash
claude mcp add --transport http quota-tracker-http http://127.0.0.1:47601/mcp
```

This is a separate `mcpServers` entry from the stdio one — you can keep both
configured and use whichever transport fits a given client. `"type": "sse"` is
the older, now-deprecated transport; this project only implements the current
Streamable HTTP one.

## Configuration

`config.json`:

```json
{
  "mcp": {
    "http": {
      "enabled": false,
      "host": "127.0.0.1",
      "port": 47601
    }
  }
}
```

`enabled` is informational for `quota doctor` and future supervisor
integrations — running `quota mcp-http` directly always starts the server
regardless of this flag (it just prints a note if it's `false`).

`quota mcp-http` **always defaults to a loopback bind**. If you set `host` to
anything other than `127.0.0.1` / `localhost` / `::1`, it prints a loud
warning on startup — nothing stops you, but you are explicitly exposing the
server (including `run_now`, which executes Claude Code) beyond your own
machine, and no authentication is added on top.

## Security model

- **Loopback by default, never `0.0.0.0` implicitly.**
- **No sessions.** The server runs the SDK's `StreamableHTTPServerTransport`
  in stateless mode (`sessionIdGenerator: undefined`) — every request is
  self-contained, matching the fact that quota-tracker's tools don't carry any
  server-side session state. This is spec-legal (session support is `MAY`,
  not `MUST`) and is the SDK's own documented pattern for a server with no
  server-initiated messages.
- **`Origin`/`Host` validation.** A request with an `Origin` header that
  doesn't match the bind address is rejected with `403` before it reaches the
  MCP layer (a request with no `Origin` at all — the normal case for
  non-browser MCP clients — is allowed). The `Host` header must also match
  the configured bind host/port. Neither check is bypassable by the HTTP
  transport in a way the stdio transport doesn't already require by other
  means — both transports run the exact same tool-authorization logic.
- **No CORS.** The server never sends `Access-Control-Allow-Origin`, so a
  browser page cannot read a cross-origin response even if it managed to
  trigger a request.
- **`GET /mcp` returns `405`.** This server has no server-initiated messages
  to push, so it refuses the optional SSE-stream GET outright instead of
  opening an idle connection.
- **Same authorization rules as stdio.** `destructive` tasks are still
  manual-only, `continuous` execution still requires the same explicit
  opt-ins, and hard quota guards are still enforced identically — the HTTP
  transport cannot bypass anything the stdio transport enforces, because both
  call into the same tool handlers.
- **Concurrency-safe by construction.** SQLite (WAL + busy timeout) already
  serializes concurrent claims across processes; `run_now` additionally
  shares one execution lock (`claude-exec.lock`) with the automatic
  scheduler, so two clients calling `run_now` at once — or one calling it
  while the night queue is already running — can't both execute Claude
  concurrently. See `docs/MCP_SCHEDULER.md` for the scheduling model itself.

If you need real authentication in the future (e.g. binding beyond
localhost), the transport is structured so that can be added as middleware in
front of `transport.handleRequest` in `src/mcp-http.ts` without touching the
tool registry.

## Troubleshooting

- `quota doctor` checks whether the configured port is free, or already held
  by a genuine quota-tracker instance (via `/health`) vs. something else.
- `curl http://127.0.0.1:47601/health` — should return
  `{"ok":true,"name":"claude-quota-tracker",...}` while the server is running.
- If a client reports a connection refused, confirm `quota mcp-http` is
  actually running (it does not run automatically — nothing installs it as a
  service by default) and that the client's URL matches `mcp.http.host`/
  `mcp.http.port` in `config.json` (default `127.0.0.1:47601`).
