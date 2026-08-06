import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: ["src/node/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "shared",
          include: ["src/shared/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: {
              configPath: "./src/workers/asset-worker/wrangler.jsonc",
            },
          }),
        ],
        test: {
          name: "asset-worker",
          include: ["src/workers/asset-worker/tests/**/*.test.ts"],
          globals: true,
          testTimeout: 50_000,
        },
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: {
              configPath: "./src/workers/router-worker/wrangler.jsonc",
            },
          }),
        ],
        test: {
          name: "router-worker",
          include: ["src/workers/router-worker/tests/**/*.test.ts"],
          testTimeout: 50_000,
        },
      },
    ],
  },
});
