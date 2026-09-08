import { PACKAGE_VERSION } from "./generated/version.js";

export { PACKAGE_VERSION };

/** Fixed product/server name, independent of package.json's npm package name ("quota-tracker"). */
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
