import { exists } from "./exists.ts";
import { findWorkspaceRoot } from "./find-workspace-root.ts";
import { memoize } from "./memoize.ts";

export type PackageManager = "bun" | "pnpm" | "yarn" | "npm" | "deno";

const LOCKS: Record<string, PackageManager> = {
  "bun.lock": "bun",
  "bun.lockb": "bun",
  "deno.lock": "deno",
  "pnpm-lock.yaml": "pnpm",
  "pnpm-workspace.yaml": "pnpm",
  "yarn.lock": "yarn",
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm",
};

export const detectPackageManager = memoize(
  async (path: string = process.cwd()): Promise<PackageManager> => {
    const root = await findWorkspaceRoot(path);

    for (const [lockfile, packageManager] of Object.entries(LOCKS)) {
      if (await exists(root, lockfile)) {
        return packageManager;
      }
    }

    if (process.env.npm_execpath?.includes("bun")) {
      return "bun";
    }

    if (process.env.DENO) {
      return "deno";
    }

    const userAgent = process.env.npm_config_user_agent?.match(
      /^(bun|deno|npm|pnpm|yarn)/,
    );
    if (userAgent) {
      return userAgent[1] as PackageManager;
    }

    return "npm";
  },
);

export async function getPackageManagerRunner(): Promise<string> {
  const packageManager = await detectPackageManager();
  return {
    bun: "bun run",
    pnpm: "pnpm",
    yarn: "yarn",
    npm: "npx",
    deno: "deno run",
  }[packageManager];
}
