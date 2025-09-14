import fs from "node:fs/promises";
import path from "node:path";

// Clear separation of workspace marker types for better maintainability
const WORKSPACE_CONFIGS = [
  "pnpm-workspace.yaml",
  "pnpm-workspace.yml",
  ".yarnrc.yml",
  ".yarnrc", // Added support for Yarn Classic workspaces
] as const;

const TOOL_SPECIFIC_CONFIGS = [
  "turbo.json",
  "nx.json",
  "lerna.json",
  "rush.json",
] as const;

export async function findWorkspaceRoot(
  dir: string = process.cwd(),
): Promise<string> {
  let currentDir = path.resolve(dir);

  // Track first tool-specific config found during traversal.
  // We continue searching for authoritative markers (.git, workspace configs)
  // but fall back to this if nothing better is found.
  let toolConfigDir: string | null = null;

  // Use filesystem root as natural boundary instead of arbitrary iteration limit
  const fsRoot = path.parse(currentDir).root;

  while (currentDir !== fsRoot) {
    try {
      const stat = await fs.stat(currentDir);
      if (!stat.isDirectory()) {
        currentDir = path.dirname(currentDir);
        continue;
      }

      // 1. Check for .git directory (absolute boundary - always stops here)
      if (await exists(currentDir, ".git")) {
        return currentDir;
      }

      // 2. Check for package.json with workspaces field
      const packageJson = await readJson(currentDir, "package.json");
      if (packageJson?.workspaces) {
        return currentDir;
      }

      // 3. Check for other workspace configuration files (batch for efficiency)
      if (await anyExists(currentDir, ...WORKSPACE_CONFIGS)) {
        return currentDir;
      }

      // 4. Remember first tool-specific config as fallback (but keep searching upward)
      if (
        !toolConfigDir &&
        (await anyExists(currentDir, ...TOOL_SPECIFIC_CONFIGS))
      ) {
        toolConfigDir = currentDir;
      }
    } catch (error: any) {
      // Only continue on expected filesystem errors (permission denied, not found)
      // Throw unexpected errors for debugging
      if (error?.code !== "EACCES" && error?.code !== "ENOENT") {
        throw error;
      }
    }

    currentDir = path.dirname(currentDir);
  }

  // Return in priority order: tool config if found, otherwise original directory
  return toolConfigDir ?? dir;
}

// Helper to read and parse JSON files safely
const readJson = async (...p: string[]): Promise<any> => {
  try {
    const content = await fs.readFile(path.join(...p), "utf8");
    return JSON.parse(content);
  } catch {
    return undefined;
  }
};

// Check if a file or directory exists
const exists = async (...p: string[]): Promise<boolean> => {
  try {
    await fs.access(path.join(...p));
    return true;
  } catch {
    return false;
  }
};

// Check if any of the provided files exist in the base directory
const anyExists = async (
  base: string,
  ...files: readonly string[]
): Promise<boolean> => {
  const results = await Promise.all(files.map((file) => exists(base, file)));
  return results.some(Boolean);
};
