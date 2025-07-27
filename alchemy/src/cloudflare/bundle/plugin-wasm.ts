import type esbuild from "esbuild";
import assert from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import type { WorkerBundle } from "../worker-bundle.ts";

export function createWasmPlugin() {
  const modules = new Map<string, WorkerBundle.Module>();
  const plugin: esbuild.Plugin = {
    name: "alchemy-wasm",
    setup(build) {
      build.onStart(() => {
        modules.clear();
      });
      build.onResolve({ filter: /\.wasm$/ }, async (args) => {
        if (!modules.has(args.path)) {
          const name = path.normalize(args.path);
          assert(build.initialOptions.outdir, "outdir is required");
          await fs.mkdir(build.initialOptions.outdir, { recursive: true });
          await fs.copyFile(
            path.join(args.resolveDir, name),
            path.join(build.initialOptions.outdir, name),
          );
          modules.set(args.path, {
            type: "wasm",
            path: name,
          });
        }
        return { external: true };
      });
    },
  };
  return { plugin, modules };
}
