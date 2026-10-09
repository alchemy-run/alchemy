import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Deploys to Cloudflare; runs under `bun test` (see the file header).
    exclude: ["test/integ.test.ts"],
    testTimeout: 30_000,
  },
});
