import { defineConfig } from "tsdown";
import pkg from "./package.json";

const entry = Object.values(pkg.exports).map((e) => e.bun);

export default defineConfig([
  {
    entry: ["bin/alchemy.ts"],
    format: ["esm"],
    clean: false,
    shims: true,
    outDir: "bin",
    outputOptions: {
      inlineDynamicImports: true,
      banner: "#!/usr/bin/env node",
    },
    noExternal: ["execa", "open", "env-paths"],
  },
  {
    entry,
    format: ["esm", "cjs"],
    clean: true,
    shims: true,
    unbundle: true,
    dts: true,
    external: () => true,
  },
]);
