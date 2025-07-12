#!/usr/bin/env bun

import { build } from "esbuild";

const watchFlag = process.argv.includes("--watch");

await build({
  entryPoints: ["bin/alchemy.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  outfile: "bin/alchemy.mjs",
  format: "esm",
  external: ["node:*"],
  mainFields: ["module", "main"],
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});
