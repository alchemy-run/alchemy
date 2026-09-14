import { defineConfig, type UserConfig } from "tsdown";

const cliBundle = (entry: string): UserConfig => ({
  entry: [entry],
  format: "esm",
  fixedExtension: false,
  clean: false,
  shims: true,
  outDir: "bin",
  dts: false,
  sourcemap: true,
  deps: {
    alwaysBundle: [
      /^react(?:\/|$)/,
      /^@alchemy\.run\/sigil(?:\/|$)/,
      /^react-reconciler(?:\/|$)/,
      /^scheduler(?:\/|$)/,
      /^react-devtools-core(?:\/|$)/,
    ],
    onlyBundle: [
      /^react(?:\/|$)/,
      /^@alchemy\.run\/sigil(?:\/|$)/,
      /^react-reconciler(?:\/|$)/,
      /^scheduler(?:\/|$)/,
      /^react-devtools-core(?:\/|$)/,
    ],
  },
  outputOptions: {
    codeSplitting: false,
  },
  tsconfig: "tsconfig.bundle.json",
});

export default defineConfig([
  cliBundle("bin/alchemy.ts"),
  cliBundle("bin/exec.ts"),
]);
