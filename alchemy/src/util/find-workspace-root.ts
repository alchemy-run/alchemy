import fs from "node:fs/promises";
import pathe from "pathe";
import { anyExists, exists } from "./exists.ts";
import { memoize } from "./memoize.ts";

export const findWorkspaceRoot = memoize(
  async (dir: string = process.cwd()): Promise<string> => {
    if ((await fs.stat(dir)).isDirectory()) {
      if (await exists(dir, ".git")) {
        // the root of the git repo is usually the workspace root and we should always stop here
        return dir;
      } else if ((await read(dir, "package.json"))?.workspaces) {
        // package.json with workspaces (bun, npm, etc.)
        return dir;
      } else if (await anyExists(dir, rootFiles)) {
        return dir;
      }
    }
    return findWorkspaceRoot(pathe.resolve(dir, ".."));
  },
);

const read = (...p: string[]): Promise<any> =>
  fs
    .readFile(pathe.join(...p), "utf8")
    .then(JSON.parse)
    .catch(() => undefined);

const rootFiles = [
  // pnpm
  "pnpm-workspace.yaml",
  "pnpm-workspace.yml",
  // lerna
  "lerna.json",
  // nx
  "nx.json",
  // turbo
  // "turbo.json",
  // rush
  "rush.json",
];
