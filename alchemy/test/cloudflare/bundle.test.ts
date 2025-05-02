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

describe("Bundle Worker Test", () => {
  test("create, test, and delete worker from bundle", async (scope) => {
    const workerName = `${BRANCH_PREFIX}-test-bundle-worker`;
    const entrypointPath = path.resolve(__dirname, "bundle-handler.ts"); // Use absolute path

    let worker: Worker | undefined;
    try {
      // Create a worker using the entrypoint file
      worker = await Worker(workerName, {
        name: workerName,
        entrypoint: entrypointPath,
        format: "esm", // Assuming bundle-handler.ts is ESM
        url: true, // Enable workers.dev URL to test the worker
        compatibilityFlags: ["nodejs_compat"],
        // Add any necessary bindings or env vars if bundle-handler.ts requires them
        // For example:
        // env: {
        //   BRAINTRUST_API_KEY: process.env.BRAINTRUST_API_KEY || "dummy-key",
        // }
      });

      // Wait for deployment propagation
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Verify the worker was created correctly
      expect(worker.id).toBeTruthy();
      expect(worker.name).toEqual(workerName);
      expect(worker.format).toEqual("esm");
      expect(worker.url).toBeTruthy();

      const response = await fetch(worker.url!);
      expect(response.status).toEqual(200);
      const text = await response.text();
      // Check against the expected response from bundle-handler.ts
      expect(text).toEqual("Hello World!");
    } catch (error) {
      console.error("Error during worker bundle test:", error);
      throw error;
    } finally {
      // Clean up the worker
      await destroy(scope);
    }
  }, 120000); // Increased timeout for bundling and deployment
});
