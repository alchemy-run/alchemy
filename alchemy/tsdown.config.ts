import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["bin/alchemy.ts"],
  format: ["esm"],
  clean: false,
  shims: true,
  outDir: "bin",
  outputOptions: {
    banner: "#!/usr/bin/env node",
  },
});
