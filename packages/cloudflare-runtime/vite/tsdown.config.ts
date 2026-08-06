import {
  InternalWorkerExportPlugin,
  InternalWorkerImportPlugin,
} from "../internal/build-tools/src/index.ts";
import cloudflare from "@alchemy.run/cloudflare-runtime/rolldown";
import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/**/*.worker.ts"],
    outDir: "dist/workers",
    tsconfig: "tsconfig.workers.json",
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
    entry: ["src/plugin.ts"],
    exports: false,
    outDir: "dist/node",
    tsconfig: "tsconfig.node.json",
    dts: true,
    shims: false,
    target: "esnext",
    format: "esm",
    deps: {
      // These are subpaths of this consolidated package. Keep them as public
      // imports so the Vite declaration bundle shares the core runtime types.
      neverBundle: [/^@alchemy\.run\/cloudflare-runtime(?:\/|$)/],
    },
    inputOptions: { makeAbsoluteExternalsRelative: true },
    outputOptions: {
      exports: "named",
    },
    plugins: [InternalWorkerImportPlugin()],
  },
]);
