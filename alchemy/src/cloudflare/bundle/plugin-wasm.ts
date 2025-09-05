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
      // Handle imports like `import "./foo.wasm"` and `import "./foo.wasm?module"`
      // TODO(john): Figure out why this suddenly became necessary
      build.onResolve({ filter: /\.wasm(\?module)?$/ }, async (args) => {
        const resolved = modules.get(args.path);
        if (resolved) {
          return { external: true, path: resolved.path };
        }

        // Normalize path and remove the `?module` query param so we have the actual file name to copy
        const name = path.normalize(args.path).replace(/\?module$/, "");

        // Copy to outdir so it's included in the upload
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

        // Resolve to the normalized file name (the `?module` query param is not needed in workerd)
        return { external: true, path: name };
      });
    },
  };
  return { plugin, modules };
}
