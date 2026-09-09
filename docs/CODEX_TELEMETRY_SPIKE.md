# Codex telemetry spike

Date: 2026-09-10. Local `codex exec --help` confirms `--json`, structured-output schema support, and explicit `read-only` / `workspace-write` sandbox modes. It also exposes dangerous approval/sandbox bypass flags; LLM Squeeze never selects those flags.

The initial adapter is `codex-manual` only. It supplies execution with an explicit sandbox but no budget source, so it cannot participate in automatic routing, pacing, fallback, or percent comparisons. Output is retained as a raw artifact while token/cost fields remain unavailable until a stable machine-readable schema is verified with redacted fixtures.
