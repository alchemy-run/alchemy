import { describe, expect } from "bun:test";
import * as path from "node:path";
import { alchemy } from "../../src/alchemy.js";
import { Worker } from "../../src/cloudflare/worker.js";
import { destroy } from "../../src/destroy.js";
import { BRANCH_PREFIX } from "../util.js";

// Import bun test utilities
import "../../src/test/bun.js";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

const entrypoint = path.resolve(__dirname, "bundle-handler.ts");
const entrypoint_als = path.resolve(__dirname, "bundle-handler-als.ts");

describe("Bundle Worker Test", () => {
  test("create, test, and delete worker from bundle", async (scope) => {
    try {
      // Create a worker using the entrypoint file
      const worker = await Worker(`${BRANCH_PREFIX}-test-bundle-worker`, {
        entrypoint,
        format: "esm", // Assuming bundle-handler.ts is ESM
        url: true, // Enable workers.dev URL to test the worker
        compatibilityFlags: ["nodejs_compat"],
      });

      const response = await fetch(worker.url!);
      expect(response.status).toEqual(200);
      const text = await response.text();
      // Check against the expected response from bundle-handler.ts
      expect(text).toEqual("Hello World!");
    } finally {
      // Clean up the worker
      await destroy(scope);
    }
  }, 120000); // Increased timeout for bundling and deployment

  test("create, test and delete a worker with 'nodejs_als' compatibility flag", async (scope) => {
    try {
      console.log(entrypoint_als);
      // Create a worker using the entrypoint file
      const worker = await Worker(`${BRANCH_PREFIX}-test-bundle-worker-als`, {
        entrypoint: entrypoint_als,
        format: "esm", // Assuming bundle-handler.ts is ESM
        url: true, // Enable workers.dev URL to test the worker
        compatibilityFlags: ["nodejs_als"],
      });

      const response = await fetch(worker.url!);
      expect(response.status).toEqual(200);
      const text = await response.text();
      // Check against the expected response from bundle-handler.ts
      expect(text).toEqual("function");
    } finally {
      // Clean up the worker
      await destroy(scope);
    }
  }, 120000); // Increased timeout for bundling and deployment

  test("error when using 'nodejs_compat' compatibility flag with a compatibility date before Sept 23rd 2024", async (scope) => {
    try {
      // Create a worker using the entrypoint file
      expect(
        Worker(`${BRANCH_PREFIX}-test-bundle-worker-legacy`, {
          entrypoint,
          format: "esm",
          url: true,
          compatibilityDate: "2024-09-22", // v1 mode (before Sept 23rd 2024)
          compatibilityFlags: ["nodejs_compat"],
        }),
      ).rejects.toThrow(
        "You must set your compatibilty date >= 2024-09-23 when using 'nodejs_compat' compatibility flag",
      );
    } finally {
      // Clean up the worker
      await destroy(scope);
    }
  }, 120000); // Increased timeout for bundling and deployment
});
