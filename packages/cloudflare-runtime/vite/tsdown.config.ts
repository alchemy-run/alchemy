import { InternalWorkerExportPlugin } from "../internal/build-tools/src/index.ts";
import cloudflare from "@alchemy.run/cloudflare-runtime/rolldown";
import { defineConfig } from "tsdown";

export default defineConfig([
  {
    cwd: "..",
    entry: ["src/vite/**/*.worker.ts"],
    outDir: "dist/vite/workers",
    tsconfig: "vite/tsconfig.workers.json",
    format: "esm",
    minify: {
      mangle: false,
    },
    plugins: [
      cloudflare({ compatibilityDate: "2026-03-10" }),
      InternalWorkerExportPlugin(),
    ],
    deps: {
      alwaysBundle: [/.+/],
    },
    dts: false,
    outputOptions: {
      entryFileNames: "[name].mjs",
    },
  },
  {
    cwd: "..",
    entry: ["src/vite/plugin.ts"],
    exports: false,
    outDir: "dist/vite/node",
    tsconfig: "tsconfig.vite-build.json",
    dts: { incremental: false },
    shims: false,
    target: "esnext",
    format: "esm",
    deps: {
      // These are subpaths of this consolidated package. Keep them as public
      // imports so the Vite declaration bundle shares the core runtime types.
      neverBundle: [/^@alchemy\.run\/cloudflare-runtime(?:\/|$)/],
    },
    inputOptions: {
      external: [
        /^#cloudflare-runtime-/,
        /^@alchemy\.run\/cloudflare-runtime(?:\/|$)/,
      ],
      makeAbsoluteExternalsRelative: true,
    },
    outputOptions: {
      exports: "named",
    },
  },
]);
