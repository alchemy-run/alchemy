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
      // Every function, and every branch of the files whose every branch a test takes.
      thresholds: {
        functions: 100,
        ...Object.fromEntries(
          [
            "Models/Decimals",
            "Models/Rationals",
            "Models/Hashes",
            "Models/Numbers",
            "Timeline",
            "Value",
          ].map((file) => [`**/packages/domain/src/Prove/internal/${file}.ts`, { branches: 100 }]),
        ),
      },
    },
  },
});
