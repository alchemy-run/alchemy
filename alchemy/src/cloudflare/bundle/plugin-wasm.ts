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
      build.onResolve({ filter: /\.wasm(\?.*)?$/ }, async (args) => {
        const resolved = modules.get(args.path);
        if (resolved) {
          return { path: resolved.path, external: true };
        }

        // Normalize path and remove the `?module` query param so we have the actual file name to copy
        const name = path.normalize(args.path).replace(/\?.*$/, "");

        // Resolve path to outdir (required for monorepos if the workdir is not the same as process.cwd())
        assert(
          build.initialOptions.absWorkingDir && build.initialOptions.outdir,
          "Missing absWorkingDir or outdir from esbuild options",
        );
        const outdir = path.resolve(
          build.initialOptions.absWorkingDir,
          build.initialOptions.outdir,
        );

        // Copy to outdir so it's included in the upload
        await fs.mkdir(outdir, { recursive: true });
        await fs.copyFile(
          path.join(args.resolveDir, name),
          path.join(outdir, name),
        );
        modules.set(args.path, {
          type: "wasm",
          path: name,
        });

        // Resolve to the normalized file name (the `?module` query param is not needed in workerd)
        return { path: name, external: true };
      });
    },
  };
  return { plugin, modules };
}
