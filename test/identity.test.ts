import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLI_NAME, MCP_SERVER_NAME, PRODUCT_NAME } from "../src/version.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIP_DIRS = new Set([
  ".agents", ".claude", ".codex", ".git", ".serena",
  "build", "data", "dist", "node_modules",
]);
const TEXT_EXTENSIONS = new Set([".json", ".md", ".mjs", ".sh", ".ts", ".yml", ".yaml"]);
const FORBIDDEN_BRANDING = [
  ["claude", "quota"].join("-"),
  ["quota", "tracker"].join("-"),
  ["QUOTA", "TRACKER", "HOME"].join("_"),
  ["Claude", "Quota", "Tracker"].join(" "),
  ["Quota", "Tracker"].join(" "),
];

function textFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : textFiles(join(dir, entry.name));
    const path = join(dir, entry.name);
    return TEXT_EXTENSIONS.has(extname(path)) ? [path] : [];
  });
}

describe("product identity", () => {
  it("uses one name for product, CLI, and MCP", () => {
    expect(PRODUCT_NAME).toBe("llm-squeeze");
    expect(CLI_NAME).toBe(PRODUCT_NAME);
    expect(MCP_SERVER_NAME).toBe(PRODUCT_NAME);
  });

  it("does not retain superseded branding in repository paths or text", () => {
    const violations: string[] = [];
    for (const path of textFiles(ROOT)) {
      const rel = relative(ROOT, path);
      const content = readFileSync(path, "utf8");
      for (const forbidden of FORBIDDEN_BRANDING) {
        if (rel.includes(forbidden) || content.includes(forbidden)) violations.push(`${rel}: ${forbidden}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
