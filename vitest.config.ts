import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [tsconfigPaths() as any],
  test: {
    pool: "threads",
    maxWorkers: 32,
    testTimeout: 120000,
    hookTimeout: 120000,
    passWithNoTests: true,
    sequence: {
      concurrent: true,
    },
    include: ["alchemy-effect/test/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/lib/**",
      "**/.{idea,git,cache,output,temp}/**",
    ],
    env: {
      NODE_ENV: "test",
    },
    globals: true,
    // reporter: ['verbose'],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: [
        "coverage/**",
        "dist/**",
        "lib/**",
        "**/node_modules/**",
        "**/*.test.ts",
        "**/*.config.*",
      ],
    },
    setupFiles: ["./vitest.setup.ts"],
  },
});
