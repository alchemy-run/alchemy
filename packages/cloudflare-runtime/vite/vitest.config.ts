import path from "node:path";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "#": path.resolve(import.meta.dirname, "../src/vite"),
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
