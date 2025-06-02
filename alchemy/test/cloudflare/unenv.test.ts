import { describe, expect } from "vitest";
import * as path from "node:path";
import { alchemy } from "../../src/alchemy.js";
import { Worker } from "../../src/cloudflare/worker.js";
import { destroy } from "../../src/destroy.js";
import { BRANCH_PREFIX } from "../util.js";

import "@cloudflare/unenv-preset/node/process";

import "../../src/test/vitest.js";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe("Worker Unenv Tests", () => {
  test("create worker with import.meta.dirname and unenv-handler", async (scope) => {
    try {
      // Create a temporary directory for the files
      // Create the worker using the entrypoint file
      const worker = await Worker(`${BRANCH_PREFIX}-test-worker-unenv`, {
        entrypoint: path.join(import.meta.dirname, "unenv-handler.ts"),
        format: "esm",
        url: true, // Enable workers.dev URL to test the worker
        compatibilityFlags: ["nodejs_compat"],
      });

      const response = await fetch(worker.url!);
      expect(await response.text()).toEqual("function");
    } finally {
      // Clean up the worker
      await destroy(scope);
    }
  }, 120000); // Increased timeout for bundling operations
});
