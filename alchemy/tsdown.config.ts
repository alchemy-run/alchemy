import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["bin/alchemy.ts"],
  format: ["esm"],
  clean: true,
  shims: true,
  outDir: "dist",
  external: ["jsonc-parser"],
  outputOptions: {
    banner: "#!/usr/bin/env node",
  },
});
