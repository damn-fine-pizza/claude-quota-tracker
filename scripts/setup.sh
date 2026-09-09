#!/bin/bash
# Install LLM Squeeze as a node launcher (recommended): compile dist, copy it
# into ~/.llm-squeeze/lib, write the ~/.local/bin/llm-squeeze launcher, register the
# launchd poller, and start SwiftBar. Requires Node 22.5+ (node:sqlite built in).
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[1/2] build"
npm run build >/dev/null

echo "[2/2] install"
node dist/cli.js install
