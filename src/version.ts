import { PACKAGE_VERSION } from "./generated/version.js";

export { PACKAGE_VERSION };

/** Fixed product/server name — kept as its own constant (not read from package.json) since it's the MCP/health-endpoint identity contract, independent of npm packaging concerns. */
export const PRODUCT_NAME = "claude-quota-tracker";

export interface RuntimeInfo {
  name: string;
  version: string;
  node: string;
  platform: string;
  arch: string;
  mcpTransports: string[];
}

export function getRuntimeInfo(): RuntimeInfo {
  return {
    name: PRODUCT_NAME,
    version: PACKAGE_VERSION,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    mcpTransports: ["stdio", "streamable-http"],
  };
}
