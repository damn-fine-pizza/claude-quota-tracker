#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const outDir = join(root, "src", "generated");
mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, "version.ts"),
  `export const PACKAGE_VERSION = ${JSON.stringify(pkg.version)};\n`,
);
