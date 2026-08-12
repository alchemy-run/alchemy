import { spawnSync } from "node:child_process";
import {
  isTransformTypesSupported,
  transformTypesFlags,
} from "../../../src/Util/Node.ts";

export interface Runtime {
  readonly name: "bun" | "node";
  readonly argv: (entry: string) => Array<string>;
  readonly available: boolean;
}

const hasBin = (bin: string): boolean => {
  try {
    // `which` doesn't exist on Windows; `where` is the equivalent.
    const probe = process.platform === "win32" ? "where" : "which";
    const r = spawnSync(probe, [bin], { encoding: "utf-8" });
    return r.status === 0 && Boolean(r.stdout?.trim());
  } catch {
    return false;
  }
};

const nodeVersion = spawnSync("node", ["-p", "process.versions.node"], {
  encoding: "utf-8",
}).stdout.trim();

export const runtimes = (): Array<Runtime> => [
  {
    name: "bun",
    argv: (entry) => ["bun", "run", entry],
    available: hasBin("bun"),
  },
  {
    name: "node",
    argv: (entry) => ["node", ...transformTypesFlags(nodeVersion), entry],
    // Node 26 removed transform-types and its built-in strip-only loader
    // cannot execute parameter properties used by Alchemy's source graph.
    // Published JS remains supported; only these source-level fixtures skip.
    available: hasBin("node") && isTransformTypesSupported(nodeVersion),
  },
];
