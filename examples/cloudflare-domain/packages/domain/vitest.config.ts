import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    // `pnpm test:coverage`: every model of the prover, and the language and runtime it reads code with, is run by a test.
    coverage: {
      provider: "v8",
      allowExternal: true,
      include: [
        "**/packages/domain/src/Prove/internal/Models/**",
        "**/packages/domain/src/Prove/internal/Library.ts",
        "**/packages/domain/src/Prove/internal/Interpreter.ts",
        "**/packages/domain/src/Prove/internal/Known.ts",
        "**/packages/domain/src/Prove/internal/Timeline.ts",
        "**/packages/domain/src/Prove/internal/Value.ts",
      ],
      reporter: ["text-summary"],
      thresholds: { functions: 100 },
    },
  },
});
