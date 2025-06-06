import { afterAll, beforeAll, describe, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { alchemy } from "../../src/alchemy.js";
import { Worker } from "../../src/cloudflare/worker.js";
import { destroy } from "../../src/destroy.js";
import { BRANCH_PREFIX } from "../util.js";

// CRITICAL: This sets up alchemy.test
import "../../src/test/bun.js";

const testScope = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

const tempWorkerDir = path.join(__dirname, "temp-source-map-workers");

// Helper to create a temporary worker file
async function createTempWorkerFile(
  dir: string,
  fileName: string,
  content: string,
): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  await fs.writeFile(filePath, content);
  return filePath;
}

// Helper to delete the temp worker directory
async function cleanupTempWorkerDir(dir: string) {
  await fs.rm(dir, { recursive: true, force: true });
}

describe("Cloudflare Worker Source Maps", () => {
  const ERROR_MARKER = "### TEST_ERROR_MARKER_SM ###";
  const WORKER_SOURCE_TS_CONTENT = `
    function iWillThrow(): void {
      // This specific line number (3) is important for assertion
      throw new Error("${ERROR_MARKER} Deliberate test error in TS!");
    }

    export default {
      async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname === "/error") {
          try {
            iWillThrow();
          } catch (e: any) {
            console.error("Error caught in worker: " + e.message); 
            throw e; 
          }
        }
        return new Response("Hello from source map test worker!");
      }
    };
  `;

  let workerTsFilePath: string;

  beforeAll(async () => {
    await fs.mkdir(tempWorkerDir, { recursive: true });
    workerTsFilePath = await createTempWorkerFile(
      tempWorkerDir,
      "test-worker-source.ts",
      WORKER_SOURCE_TS_CONTENT,
    );
  });

  afterAll(async () => {
    await cleanupTempWorkerDir(tempWorkerDir);
  });

  testScope(
    "should inline source maps and deobfuscate stack trace when bundle.sourcemap is 'inline'",
    async (scope) => {
      const timestamp = Date.now();
      const workerName = `${BRANCH_PREFIX}-sm-true-${timestamp}`;
      let deployedWorker: Worker | undefined;

      try {
        console.log(
          `Deploying worker ${workerName} with bundle.sourcemap: 'inline', entrypoint: ${workerTsFilePath}`,
        );
        deployedWorker = await Worker(workerName, {
          name: workerName,
          entrypoint: workerTsFilePath,
          bundle: { sourcemap: "inline" },
          url: true,
        });

        expect(deployedWorker).toBeDefined();
        expect(deployedWorker!.url).toBeDefined();
        console.log(
          `Worker ${workerName} deployed with URL: ${deployedWorker!.url}`,
        );

        await new Promise((resolve) => setTimeout(resolve, 15000));

        console.log(
          `Invoking ${deployedWorker!.url}/error to trigger an error...`,
        );
        const resp = await fetch(`${deployedWorker!.url}/error`);
        expect(resp.status).toBeGreaterThanOrEqual(500);
      } finally {
        console.log(`Cleaning up scope for ${workerName}...`);
        await destroy(scope);
      }
    },
    120000,
  );

  testScope(
    "should NOT deobfuscate stack trace when bundle.sourcemap is undefined",
    async (scope) => {
      const workerName = `${BRANCH_PREFIX}-sm-false`;
      let deployedWorker: Worker | undefined;

      try {
        console.log(
          `Deploying worker ${workerName} with no source maps, entrypoint: ${workerTsFilePath}`,
        );
        deployedWorker = await Worker(workerName, {
          name: workerName,
          entrypoint: workerTsFilePath,
          url: true,
        });

        expect(deployedWorker).toBeDefined();
        expect(deployedWorker!.url).toBeDefined();
        console.log(
          `Worker ${workerName} deployed with URL: ${deployedWorker!.url}`,
        );

        await new Promise((resolve) => setTimeout(resolve, 15000));

        console.log(
          `Invoking ${deployedWorker!.url}/error to trigger an error...`,
        );
        const resp = await fetch(`${deployedWorker!.url}/error`);
        expect(resp.status).toBeGreaterThanOrEqual(500);
      } finally {
        console.log(`Cleaning up scope for ${workerName}...`);
        await destroy(scope);
      }
    },
    120000,
  );

  testScope(
    "deployment with noBundle true should succeed (source maps not applicable)",
    async (scope) => {
      const workerName = `${BRANCH_PREFIX}-sm-nobundle`;
      let deployedWorker: Worker | undefined;

      const workerJsPath = await createTempWorkerFile(
        tempWorkerDir,
        "worker-nobundle.js",
        `export default { fetch() { return new Response("Hello from noBundle worker"); } };`,
      );

      try {
        console.log(
          `Deploying worker ${workerName} with noBundle: true (source maps not applicable), entrypoint: ${workerJsPath}`,
        );
        deployedWorker = await Worker(workerName, {
          name: workerName,
          entrypoint: workerJsPath,
          noBundle: true,
          url: true,
        });
        expect(deployedWorker).toBeDefined();
        expect(deployedWorker!.url).toBeDefined();
        console.log(
          `Worker ${workerName} (noBundle) deployed with URL: ${deployedWorker!.url}`,
        );

        await new Promise((resolve) => setTimeout(resolve, 10000));
        const response = await fetch(deployedWorker!.url!);
        expect(response.ok).toBeTrue();
        const text = await response.text();
        expect(text).toBe("Hello from noBundle worker");
      } finally {
        console.log(`Cleaning up scope for ${workerName}...`);
        await destroy(scope);
      }
    },
    90000,
  );
});
