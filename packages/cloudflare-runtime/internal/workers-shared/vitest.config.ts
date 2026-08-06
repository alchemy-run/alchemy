import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import path from "node:path";
import { defineConfig } from "vitest/config";

const sourceRoot = path.resolve(
  import.meta.dirname,
  "../../src/internal/workers-shared",
);

export default defineConfig({
  root: sourceRoot,
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: ["node/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "shared",
          include: ["shared/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: {
              configPath: path.join(
                sourceRoot,
                "workers/asset-worker/wrangler.jsonc",
              ),
            },
          }),
        ],
        test: {
          name: "asset-worker",
          include: ["workers/asset-worker/tests/**/*.test.ts"],
          globals: true,
          testTimeout: 50_000,
        },
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: {
              configPath: path.join(
                sourceRoot,
                "workers/router-worker/wrangler.jsonc",
              ),
            },
          }),
        ],
        test: {
          name: "router-worker",
          include: ["workers/router-worker/tests/**/*.test.ts"],
          testTimeout: 50_000,
        },
      },
    ],
  },
});
