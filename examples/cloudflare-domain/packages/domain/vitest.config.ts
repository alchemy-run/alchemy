import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    // `pnpm test:coverage`: every model of the prover, and the library it reads, is run by a test.
    coverage: {
      provider: "v8",
      allowExternal: true,
      include: [
        "**/packages/domain/src/Prove/internal/Models/**",
        "**/packages/domain/src/Prove/internal/Library.ts",
      ],
      reporter: ["text-summary"],
      thresholds: { functions: 100 },
    },
  },
});
