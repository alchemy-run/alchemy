import path from "pathe";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

const AWS_API_GATEWAY_INCLUDE = "test/AWS/ApiGateway/**/*.test.ts";
const PLANETSCALE_INCLUDE = "test/Planetscale/**/*.test.ts";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
    // Vite's default external condiitons are ["node", "module-sync"].
    // Extend this to include Bun so `@distilled.cloud/*` packages are
    // resolved from `src/*.ts` instead of `lib/*.js`.
    externalConditions: ["bun", "node", "module-sync"],
  },
  test: {
    env: loadEnv("test", path.resolve(import.meta.dirname, "..", ".."), ""),
    pool: "forks",
    maxWorkers: 32,
    sequence: { concurrent: true },
    testTimeout: 120_000,
    hookTimeout: 120_000,
    passWithNoTests: true,
    projects: [
      // Run most tests with the above defaults, excluding special cases.
      {
        extends: true,
        test: {
          name: "default",
          include: ["test/**/*.test.ts"],
          exclude: [AWS_API_GATEWAY_INCLUDE, PLANETSCALE_INCLUDE],
        },
      },

      // AWS API Gateway has tight per-account rate limits (e.g.
      // DeleteRestApi allows 1 request per 30s). Run with extended
      // timeouts and no concurrency.
      {
        extends: true,
        test: {
          name: "aws/api-gateway",
          fileParallelism: false,
          sequence: { concurrent: false },
          testTimeout: 600_000,
          hookTimeout: 600_000,
          include: [AWS_API_GATEWAY_INCLUDE],
        },
      },

      // PlanetScale resources can take up to 20 minutes to provision;
      // run with extended timeouts.
      {
        extends: true,
        test: {
          name: "planetscale",
          testTimeout: 1_800_000,
          hookTimeout: 1_800_000,
          include: [PLANETSCALE_INCLUDE],
        },
      },
    ],
  },
});
