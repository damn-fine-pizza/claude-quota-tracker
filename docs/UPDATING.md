# Updating

```bash
quota update --check   # read-only: current vs. latest available
quota update            # git pull + rebuild + reinstall
```

Neither command touches any MCP client's `.mcp.json` — the installed
launcher stays at `~/.local/bin/quota`, so once a client points at `quota mcp`
or `http://127.0.0.1:47601/mcp`, it keeps working across updates without
reconfiguration.

## `quota update --check`

Queries the GitHub Releases API for `update.repository` in `config.json`
(default `damn-fine-pizza/claude-quota-tracker` — this **never** points at
the upstream `cooco119/claude-quota-tracker`, even if you haven't configured
anything). It's read-only, uses a short timeout, and degrades gracefully:

```text
current: 0.3.0
available: 0.3.1
update available: yes
```

If the repository has no releases published yet, or the network is
unreachable, it says so plainly instead of failing — nothing is written to
disk by `--check`, ever.

## `quota update`

This only works when `quota` was installed from a git checkout, which is how
`scripts/setup.sh` / `quota install` already work. At install time, the
checkout's path is recorded to `~/.quota-tracker/install-source.json`; update
uses that (falling back to the current directory if it looks like this repo)
to find its way back to your clone regardless of where you run `quota update`
from.

What it does, in order:

1. **Abort if the working tree is dirty.** `git status --porcelain` must be
   empty. Nothing else runs — your uncommitted changes are never touched.
2. `git fetch origin`
3. `git pull --ff-only` — never `git reset --hard`, never switches branches.
   If your branch has diverged (a non-fast-forward pull), it stops here with
   a clear message instead of forcing anything.
4. `npm ci && npm run build`
5. Re-runs `quota install` — idempotent: it refreshes the copied runtime, the
   `~/.local/bin/quota` launcher, and the systemd timer / launchd agent (on
   whichever platform applies), without re-registering anything that's
   already correctly configured.

### If it can't find your checkout

If `quota update` can't resolve a source checkout (e.g. this install predates
the `install-source.json` marker, or the recorded path no longer exists), it
tells you the exact manual sequence instead of guessing:

```bash
cd <your-clone> && git pull && npm ci && npm run build && node dist/cli.js install
```

### What it deliberately does not do

- No self-update mechanism that downloads and executes arbitrary code — it's
  `git`/`npm`, the same tools `scripts/setup.sh` already uses.
- No automatic branch switching, no destructive git operations.
- No fallback to the upstream fork under any circumstance.
