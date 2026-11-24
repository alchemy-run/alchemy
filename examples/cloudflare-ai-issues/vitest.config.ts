import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Deploys the example: run it with `pnpm test:integ`.
    exclude: ["test/integ.test.ts"],
    testTimeout: 30_000,
  },
});
