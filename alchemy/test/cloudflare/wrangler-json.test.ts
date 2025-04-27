import { describe, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { alchemy } from "../../src/alchemy";
import { createCloudflareApi } from "../../src/cloudflare/api";
import { Worker } from "../../src/cloudflare/worker";
import { WranglerJson } from "../../src/cloudflare/wrangler.json";
import { destroy } from "../../src/destroy";
import { BRANCH_PREFIX } from "../util";

import "../../src/test/bun";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

// Create a Cloudflare API client for verification
const api = await createCloudflareApi();

// Sample ESM worker script
const esmWorkerScript = `
  export default {
    async fetch(request, env, ctx) {
      return new Response('Hello ESM world!', { status: 200 });
    }
  };
`;

describe("WranglerJson Resource", () => {
  describe("with worker", () => {
    test("infers spec from worker", async (scope) => {
      const name = `${BRANCH_PREFIX}-test-worker-esm-1`;
      const tempDir = path.join(".out", "alchemy-entrypoint-test");
      const entrypoint = path.join(tempDir, "worker.ts");

      try {
        // Create a temporary directory for the entrypoint file
        await fs.rm(tempDir, { recursive: true, force: true });
        await fs.mkdir(tempDir, { recursive: true });
        await fs.writeFile(entrypoint, esmWorkerScript);

        const worker = await Worker(name, {
          format: "esm",
          entrypoint,
          compatibilityDate: "2024-01-01",
          compatibilityFlags: ["nodejs_compat"],
        });

        const { spec } = await WranglerJson(
          `${BRANCH_PREFIX}-test-wrangler-json-1`,
          { worker }
        );

        expect(spec.name).toEqual(name);
        expect(spec.main).toEqual(entrypoint);
        expect(spec.compatibility_date).toEqual(worker.compatibilityDate);
        expect(spec.compatibility_flags).toEqual(worker.compatibilityFlags);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
        await destroy(scope);
      }
    });

    test("requires entrypoint", async (scope) => {
      const name = `${BRANCH_PREFIX}-test-worker-esm-2`;

      try {
        const worker = await Worker(name, {
          format: "esm",
          script: esmWorkerScript,
        });

        const id = `${BRANCH_PREFIX}-test-wrangler-json-2`;

        await expect(async () => await WranglerJson(id, { worker })).toThrow(
          "Worker must have an entrypoint to generate a wrangler.json"
        );
      } finally {
        await destroy(scope);
      }
    });

    test("with browser binding", async (scope) => {
      const name = `${BRANCH_PREFIX}-test-worker-browser`;
      const tempDir = path.join(".out", "alchemy-browser-test");
      const entrypoint = path.join(tempDir, "worker.ts");

      try {
        // Create a temporary directory for the entrypoint file
        await fs.rm(tempDir, { recursive: true, force: true });
        await fs.mkdir(tempDir, { recursive: true });
        await fs.writeFile(entrypoint, esmWorkerScript);

        const worker = await Worker(name, {
          format: "esm",
          entrypoint,
          compatibilityDate: "2024-01-01",
          bindings: {
            browser: { type: "browser" },
          },
        });

        const { spec } = await WranglerJson(
          `${BRANCH_PREFIX}-test-wrangler-json-browser`,
          { worker }
        );

        expect(spec.name).toEqual(name);
        expect(spec.browser).toBeDefined();
        expect(spec.browser?.binding).toEqual("browser");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
        await destroy(scope);
      }
    });
  });

  describe("without worker", () => {
    test("throws error", async (scope) => {
      const id = `${BRANCH_PREFIX}-test-wrangler-json-3`;

      try {
        await expect(
          async () => await WranglerJson(id, { worker: undefined as any })
        ).toThrow(
          "undefined is not an object (evaluating 'props.worker.entrypoint')"
        );
      } finally {
        await destroy(scope);
      }
    });
  });
});
