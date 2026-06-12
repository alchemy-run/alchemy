import path from "pathe";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    env: loadEnv("test", path.resolve(import.meta.dirname, "..", ".."), ""),
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    sequence: { concurrent: true },
  },
});
