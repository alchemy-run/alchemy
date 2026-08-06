import { InternalWorkerImportPlugin } from "../internal/build-tools/src/index.ts";
import path from "node:path";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Tests that boot a dev server pull in the internal Workers via `worker:`
  // imports, which are otherwise only resolved by the tsdown build.
  plugins: [
    InternalWorkerImportPlugin({
      workersRoot: path.resolve(import.meta.dirname, "dist/workers"),
    }),
  ],
  resolve: {
    alias: {
      "#": path.resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    env: loadEnv("test", process.cwd(), "TEST"),
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: "forks",
    fileParallelism: true,
  },
});
