import fs from "node:fs";

export type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

export function detectPackageManager(): PackageManager {
  if (fs.existsSync("bun.lockb")) return "bun";
  if (fs.existsSync("pnpm-lock.yaml")) return "pnpm";
  if (fs.existsSync("yarn.lock")) return "yarn";

  if (process.env.npm_execpath?.includes("bun")) {
    return "bun";
  }

  const userAgent = process.env.npm_config_user_agent;
  if (userAgent) {
    if (userAgent.startsWith("bun")) return "bun";
    if (userAgent.startsWith("pnpm")) return "pnpm";
    if (userAgent.startsWith("yarn")) return "yarn";
    if (userAgent.startsWith("npm")) return "npm";
  }

  return "npm";
}
