import { PACKAGE_VERSION } from "./generated/version.js";

export { PACKAGE_VERSION };

/** Single public identity shared by the product, executable, package, and MCP server. */
export const PRODUCT_NAME = "llm-squeeze";

/** Canonical executable introduced by the product rename. */
export const CLI_NAME = "llm-squeeze";

export const MCP_SERVER_NAME = PRODUCT_NAME;

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
