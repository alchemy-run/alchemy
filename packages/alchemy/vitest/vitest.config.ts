import path from "node:path";
import { defineConfig } from "vitest/config";

const packageRoot = path.resolve(import.meta.dirname, "..");

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(packageRoot, "src"),
    },
  },
  test: {
    root: packageRoot,
    include: ["vitest/**/*.test.ts"],
  },
});
