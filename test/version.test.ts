import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getRuntimeInfo, PACKAGE_VERSION, PRODUCT_NAME } from "../src/version.js";

describe("version", () => {
  it("PACKAGE_VERSION matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(PACKAGE_VERSION).toBe(pkg.version);
  });

  it("PRODUCT_NAME is the fixed server/product name", () => {
    expect(PRODUCT_NAME).toBe("claude-quota-tracker");
  });

  it("getRuntimeInfo returns the documented shape", () => {
    const info = getRuntimeInfo();
    expect(info).toEqual({
      name: "claude-quota-tracker",
      version: PACKAGE_VERSION,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      mcpTransports: ["stdio", "streamable-http"],
    });
  });
});
