import { describe, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { alchemy } from "../../src/alchemy.js";
import { Ai } from "../../src/cloudflare/ai.js";
import { Worker } from "../../src/cloudflare/worker.js";
import { WranglerJson } from "../../src/cloudflare/wrangler.json.js";
import { destroy } from "../../src/destroy.js";
import { BRANCH_PREFIX } from "../util.js";

import "../../src/test/bun.js";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

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
          compatibilityFlags: ["nodejs_compat"],
        });

        const { spec } = await WranglerJson(
          `${BRANCH_PREFIX}-test-wrangler-json-1`,
          { worker },
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
          "Worker must have an entrypoint to generate a wrangler.json",
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
          bindings: {
            browser: { type: "browser" },
          },
        });

        const { spec } = await WranglerJson(
          `${BRANCH_PREFIX}-test-wrangler-json-browser`,
          { worker },
        );

        expect(spec.name).toEqual(name);
        expect(spec.browser).toBeDefined();
        expect(spec.browser?.binding).toEqual("browser");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
        await destroy(scope);
      }
    });

    test("with AI binding", async (scope) => {
      const name = `${BRANCH_PREFIX}-test-worker-ai`;
      const tempDir = path.join(".out", "alchemy-ai-test");
      const entrypoint = path.join(tempDir, "worker.ts");

      try {
        // Create a temporary directory for the entrypoint file
        await fs.rm(tempDir, { recursive: true, force: true });
        await fs.mkdir(tempDir, { recursive: true });
        await fs.writeFile(entrypoint, esmWorkerScript);

        const worker = await Worker(name, {
          format: "esm",
          entrypoint,
          bindings: {
            AI: new Ai(),
          },
        });

        const { spec } = await WranglerJson(
          `${BRANCH_PREFIX}-test-wrangler-json-ai`,
          { worker },
        );

        expect(spec.name).toEqual(name);
        expect(spec.ai).toBeDefined();
        expect(spec.ai?.binding).toEqual("AI");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
        await destroy(scope);
      }
    });
  });
});
