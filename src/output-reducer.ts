/** Deterministic terminal-output reduction; never changes raw artifacts or exit status. */
export function reduceOutput(raw: string, maxLines = 120): { text: string; omittedLines: number } {
  const lines = raw.split("\n"); if (lines.length <= maxLines) return { text: raw, omittedLines: 0 };
  const head = Math.ceil(maxLines * 0.7); const tail = maxLines - head;
  return { text: [...lines.slice(0, head), `[... ${lines.length - maxLines} lines omitted ...]`, ...lines.slice(-tail)].join("\n"), omittedLines: lines.length - maxLines };
}
