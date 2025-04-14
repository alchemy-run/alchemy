import { describe, expect } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import { alchemy } from "../../src/alchemy";
import { createCloudflareApi } from "../../src/cloudflare/api";
import { Assets } from "../../src/cloudflare/assets";
import { R2Bucket } from "../../src/cloudflare/bucket";
import { DurableObjectNamespace } from "../../src/cloudflare/durable-object-namespace";
import { KVNamespace } from "../../src/cloudflare/kv-namespace";
import { Worker } from "../../src/cloudflare/worker";
import { Workflow } from "../../src/cloudflare/workflow";
import { destroy } from "../../src/destroy";
import "../../src/test/bun";
import { BRANCH_PREFIX } from "../util";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
  destroy: false,
});

// Create a Cloudflare API client for verification
const api = await createCloudflareApi();

// Helper function to check if a worker exists
async function assertWorkerDoesNotExist(workerName: string) {
  try {
    const response = await api.get(
      `/accounts/${api.accountId}/workers/scripts/${workerName}`
    );
    expect(response.status).toEqual(404);
  } catch (error) {
    // 404 is expected, so we can ignore it
    return;
  }
}

describe("Worker Resource", () => {
  // Sample worker script (CJS style)
  const workerScript = `
    addEventListener('fetch', event => {
      event.respondWith(new Response('Hello world!', { status: 200 }));
    });
  `;

  // Sample ESM worker script
  const esmWorkerScript = `
    export default {
      async fetch(request, env, ctx) {
        return new Response('Hello ESM world!', { status: 200 });
      }
    };
  `;

  // Sample ESM worker script with a Durable Object
  const durableObjectWorkerScript = `
    export class Counter {
      constructor(state, env) {
        this.state = state;
        this.env = env;
        this.counter = 0;
      }

      async fetch(request) {
        this.counter++;
        return new Response('Counter: ' + this.counter, { status: 200 });
      }
    }

    export default {
      async fetch(request, env, ctx) {
        // Use the DO binding if needed
        if (request.url.includes('/counter')) {
          const id = env.COUNTER.idFromName('default');
          const stub = env.COUNTER.get(id);
          return stub.fetch(request);
        }
        
        return new Response('Hello with Durable Object!', { status: 200 });
      }
    };
  `;

  // Sample ESM worker script with KV Namespace
  const kvWorkerScript = `
    export default {
      async fetch(request, env, ctx) {
        // Use the KV binding
        if (request.url.includes('/kv')) {
          const value = await env.TEST_KV.get('testKey');
          return new Response('KV Value: ' + (value || 'not found'), { status: 200 });
        }
        
        return new Response('Hello with KV Namespace!', { status: 200 });
      }
    };
  `;

  // Sample ESM worker script with R2 bucket
  const r2WorkerScript = `
    export default {
      async fetch(request, env, ctx) {
        // Use the R2 binding
        if (request.url.includes('/r2-info')) {
          // Just confirm we have access to the binding
          return new Response(JSON.stringify({
            hasR2: !!env.STORAGE,
            bucketName: env.STORAGE.name || 'unknown'
          }), { 
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        
        return new Response('Hello with R2 Bucket!', { status: 200 });
      }
    };
  `;

  // Sample ESM worker script with multiple bindings
  const multiBindingsWorkerScript = `
    export class Counter {
      constructor(state, env) {
        this.state = state;
        this.env = env;
        this.counter = 0;
      }

      async fetch(request) {
        this.counter++;
        return new Response('Counter: ' + this.counter, { status: 200 });
      }
    }

    export default {
      async fetch(request, env, ctx) {
        // Path-based routing to demonstrate different bindings
        const url = new URL(request.url);
        
        if (url.pathname.includes('/counter')) {
          const id = env.COUNTER.idFromName('default');
          const stub = env.COUNTER.get(id);
          return stub.fetch(request);
        }
        
        if (url.pathname.includes('/kv')) {
          const value = await env.TEST_KV.get('testKey');
          return new Response('KV Value: ' + (value || 'not found'), { status: 200 });
        }
        
        if (url.pathname.includes('/secret')) {
          return new Response('Secret: ' + env.API_KEY, { status: 200 });
        }
        
        return new Response('Hello worker with multiple bindings!', { status: 200 });
      }
    };
  `;

  // Sample ESM worker script with environment variables
  const envVarsWorkerScript = `
    export default {
      async fetch(request, env, ctx) {
        const url = new URL(request.url);
        
        // Return the value of the requested environment variable
        if (url.pathname.startsWith('/env/')) {
          const varName = url.pathname.split('/env/')[1];
          const value = env[varName];
          return new Response(value || 'undefined', { 
            status: 200,
            headers: { 'Content-Type': 'text/plain' }
          });
        }
        
        // Return all environment variables
        if (url.pathname === '/env') {
          const envVars = Object.entries(env)
            .filter(([key]) => key !== 'COUNTER' && !key.includes('Durable')) // Filter out bindings
            .map(([key, value]) => \`\${key}: \${value}\`)
            .join('\\n');
          
          return new Response(envVars, { 
            status: 200,
            headers: { 'Content-Type': 'text/plain' }
          });
        }
        
        return new Response('Hello with environment variables!', { status: 200 });
      }
    };
  `;

  // Sample ESM worker script with original Counter class
  const doMigrationWorkerScriptV1 = `
    export class Counter {
      constructor(state, env) {
        this.state = state;
        this.env = env;
        this.counter = 0;
      }

      async fetch(request) {
        this.counter++;
        return new Response('Counter V1: ' + this.counter, { status: 200 });
      }
    }

    export default {
      async fetch(request, env, ctx) {
        if (request.url.includes('/counter')) {
          const id = env.COUNTER.idFromName('default');
          const stub = env.COUNTER.get(id);
          return stub.fetch(request);
        }
        return new Response('Hello with Counter V1!', { status: 200 });
      }
    };
  `;

  // Sample ESM worker script with renamed CounterV2 class
  const doMigrationWorkerScriptV2 = `
    export class CounterV2 {
      constructor(state, env) {
        this.state = state;
        this.env = env;
        this.counter = 0;
      }

      async fetch(request) {
        this.counter++;
        return new Response('Counter V2: ' + this.counter, { status: 200 });
      }
    }

    export default {
      async fetch(request, env, ctx) {
        if (request.url.includes('/counter')) {
          const id = env.COUNTER.idFromName('default');
          const stub = env.COUNTER.get(id);
          return stub.fetch(request);
        }
        return new Response('Hello with Counter V2!', { status: 200 });
      }
    };
  `;

  test("create, update, and delete worker (CJS format)", async (scope) => {
    const workerName = `${BRANCH_PREFIX}-test-worker-cjs-1`;

    let worker: Worker | undefined = undefined;
    try {
      // Create a worker with an explicit name
      worker = await Worker(workerName, {
        name: workerName,
        script: workerScript,
        format: "cjs",
      });

      // Apply to create the worker
      expect(worker.id).toBeTruthy();
      expect(worker.name).toEqual(workerName);
      expect(worker.format).toEqual("cjs");

      // Update the worker with a new script
      const updatedScript = `
        addEventListener('fetch', event => {
          event.respondWith(new Response('Hello updated world!', { status: 200 }));
        });
      `;

      worker = await Worker(workerName, {
        name: workerName,
        script: updatedScript,
        format: "cjs",
      });

      expect(worker.id).toEqual(worker.id);
    } finally {
      await destroy(scope);
      await assertWorkerDoesNotExist(workerName);
    }
  });

  test("create, update, and delete worker (ESM format)", async (scope) => {
    const workerName = `${BRANCH_PREFIX}-test-worker-esm-1`;

    let worker: Worker | undefined = undefined;
    try {
      // Create a worker with ESM format
      worker = await Worker(workerName, {
        name: workerName,
        script: esmWorkerScript,
        format: "esm", // Explicitly using ESM
      });

      // Apply to create the worker
      expect(worker.id).toBeTruthy();
      expect(worker.name).toEqual(workerName);
      expect(worker.format).toEqual("esm");

      // Update the worker with a new ESM script
      const updatedEsmScript = `
        export default {
          async fetch(request, env, ctx) {
            return new Response('Hello updated ESM world!', { status: 200 });
          }
        };
      `;

      worker = await Worker(workerName, {
        name: workerName,
        script: updatedEsmScript,
        format: "esm",
      });

      expect(worker.id).toEqual(worker.id);
    } finally {
      await destroy(scope);
      await assertWorkerDoesNotExist(workerName);
    }
  });

  test("convert between ESM and CJS formats", async (scope) => {
    const workerName = `${BRANCH_PREFIX}-test-worker-format-conversion-convert-1`;

    let worker: Worker | undefined = undefined;
    try {
      // First create with ESM format
      worker = await Worker(workerName, {
        name: workerName,
        script: esmWorkerScript,
        format: "esm",
      });

      expect(worker.format).toEqual("esm");

      // Update to CJS format
      worker = await Worker(workerName, {
        name: workerName,
        script: workerScript,
        format: "cjs",
      });
      expect(worker.format).toEqual("cjs");

      // Update back to ESM format
      worker = await Worker(workerName, {
        name: workerName,
        script: esmWorkerScript,
        format: "esm",
      });

      expect(worker.format).toEqual("esm");
    } finally {
      await destroy(scope);
      await assertWorkerDoesNotExist(workerName);
    }
  });

  test("fails when creating a worker with a duplicate name", async (scope) => {
    const workerName = `${BRANCH_PREFIX}-test-worker-duplicate`;

    try {
      // First, create a worker successfully
      await Worker(workerName, {
        name: workerName,
        script: workerScript,
        format: "cjs",
      });

      // Try to create another worker with the same name, which should fail
      const duplicateWorker = Worker(`${workerName}-dup`, {
        name: workerName, // Same name as firstWorker
        script: workerScript,
        format: "cjs",
      });
      await expect(duplicateWorker).rejects.toThrow(
        `Worker with name '${workerName}' already exists. Please use a unique name.`
      );
    } finally {
      await destroy(scope);
    }
  });

  test("create and delete worker with Durable Object binding", async (scope) => {
    const workerName = `${BRANCH_PREFIX}-test-worker-do-binding-do-1`;

    let worker: Worker | undefined = undefined;
    try {
      // First create the worker without the DO binding
      worker = await Worker(workerName, {
        name: workerName,
        script: durableObjectWorkerScript,
        format: "esm",
        // No bindings yet
      });

      expect(worker.id).toBeTruthy();
      expect(worker.name).toEqual(workerName);
      expect(worker.bindings).toBeEmpty();

      // Create a Durable Object namespace
      const counterNamespace = new DurableObjectNamespace(
        "test-counter-namespace",
        {
          className: "Counter",
          scriptName: workerName,
        }
      );

      // Update the worker with the DO binding
      worker = await Worker(workerName, {
        name: workerName,
        script: durableObjectWorkerScript,
        format: "esm",
        bindings: {
          COUNTER: counterNamespace,
        },
      });

      expect(worker.id).toBeTruthy();
      expect(worker.name).toEqual(workerName);
      expect(worker.bindings).toBeDefined();
    } finally {
      await destroy(scope);
      await assertWorkerDoesNotExist(workerName);
    }
  });

  test("create and delete worker with KV Namespace binding", async (scope) => {
    const workerName = `${BRANCH_PREFIX}-test-worker-kv-binding-kv-1`;

    let worker: Worker | undefined = undefined;
    let testKv: KVNamespace | undefined = undefined;
    try {
      // Create a KV namespace with initial values
      testKv = await KVNamespace("test-kv-namespace", {
        title: `${BRANCH_PREFIX} Test KV Namespace 2`,
        values: [
          {
            key: "testKey",
            value: "initial-value",
          },
        ],
      });

      // Create a worker with the KV Namespace binding
      worker = await Worker(workerName, {
        name: workerName,
        script: kvWorkerScript,
        format: "esm",
        bindings: {
          TEST_KV: testKv,
        },
      });
      expect(worker.id).toBeTruthy();
      expect(worker.name).toEqual(workerName);
      expect(worker.bindings).toBeDefined();
    } finally {
      await destroy(scope);
      await assertWorkerDoesNotExist(workerName);
    }
  });

  test("create and delete worker with multiple bindings", async (scope) => {
    const workerName = `${BRANCH_PREFIX}-test-worker-multi-bindings-multi-1`;

    // Create a Durable Object namespace
    const counterNamespace = new DurableObjectNamespace(
      "test-counter-namespace",
      {
        className: "Counter",
        scriptName: workerName,
      }
    );

    // Create a KV namespace
    const testKv = await KVNamespace("test-kv-namespace", {
      title: `${BRANCH_PREFIX} Test KV Namespace 1`,
      values: [
        {
          key: "testKey",
          value: "initial-value",
        },
      ],
    });

    let worker: Worker | undefined = undefined;

    try {
      // First create the worker without bindings
      worker = await Worker(workerName, {
        name: workerName,
        script: multiBindingsWorkerScript,
        format: "esm",
      });

      expect(worker.id).toBeTruthy();
      expect(worker.name).toEqual(workerName);

      // Update the worker with all bindings
      worker = await Worker(workerName, {
        name: workerName,
        script: multiBindingsWorkerScript,
        format: "esm",
        bindings: {
          COUNTER: counterNamespace,
          TEST_KV: testKv,
          API_KEY: "test-api-key-value",
        },
      });

      expect(worker.id).toBeTruthy();
      expect(worker.name).toEqual(workerName);
      expect(worker.bindings).toBeDefined();
    } finally {
      await destroy(scope);
      await assertWorkerDoesNotExist(workerName);
    }
  });

  // Add a new test for environment variables
  test("create and test worker with environment variables", async (scope) => {
    const workerName = `${BRANCH_PREFIX}-test-worker-env-vars-env-1`;
    let worker: Worker | undefined = undefined;
    try {
      // Create a worker with environment variables
      worker = await Worker(workerName, {
        name: workerName,
        script: envVarsWorkerScript,
        format: "esm",
        env: {
          TEST_API_KEY: "test-api-key-123",
          NODE_ENV: "testing",
          APP_DEBUG: "true",
        },
        url: true, // Enable workers.dev URL to test the worker
      });

      expect(worker.id).toBeTruthy();
      expect(worker.name).toEqual(workerName);
      expect(worker.env).toBeDefined();
      expect(worker.env?.TEST_API_KEY).toEqual("test-api-key-123");
      expect(worker.env?.NODE_ENV).toEqual("testing");
      expect(worker.url).toBeTruthy();

      // Wait for the worker to be available
      await new Promise((resolve) => setTimeout(resolve, 1000));

      if (worker.url) {
        // Test that the environment variables are accessible in the worker
        const response = await fetch(`${worker.url}/env/TEST_API_KEY`);
        expect(response.status).toEqual(200);
        const text = await response.text();
        expect(text).toEqual("test-api-key-123");

        // Test another environment variable
        const nodeEnvResponse = await fetch(`${worker.url}/env/NODE_ENV`);
        expect(nodeEnvResponse.status).toEqual(200);
        const nodeEnvText = await nodeEnvResponse.text();
        expect(nodeEnvText).toEqual("testing");
      }

      // Update the worker with different environment variables
      worker = await Worker(workerName, {
        name: workerName,
        script: envVarsWorkerScript,
        format: "esm",
        env: {
          TEST_API_KEY: "updated-key-456",
          NODE_ENV: "production",
          NEW_VAR: "new-value",
        },
        url: true,
      });

      expect(worker.id).toEqual(worker.id);
      expect(worker.env?.TEST_API_KEY).toEqual("updated-key-456");
      expect(worker.env?.NODE_ENV).toEqual("production");
      expect(worker.env?.NEW_VAR).toEqual("new-value");
      // APP_DEBUG should no longer be present
      expect(worker.env?.APP_DEBUG).toBeUndefined();

      // Wait for the worker update to propagate
      await new Promise((resolve) => setTimeout(resolve, 5000));

      if (worker.url) {
        // Test that the updated environment variables are accessible
        const response = await fetch(`${worker.url}/env/TEST_API_KEY`);
        expect(response.status).toEqual(200);
        const text = await response.text();
        expect(text).toEqual("updated-key-456");

        // Test new environment variable
        const newVarResponse = await fetch(`${worker.url}/env/NEW_VAR`);
        expect(newVarResponse.status).toEqual(200);
        const newVarText = await newVarResponse.text();
        expect(newVarText).toEqual("new-value");

        // Test that the removed environment variable is no longer accessible
        const removedVarResponse = await fetch(`${worker.url}/env/APP_DEBUG`);
        expect(removedVarResponse.status).toEqual(200);
        const removedVarText = await removedVarResponse.text();
        expect(removedVarText).toEqual("undefined");
      }
    } finally {
      await destroy(scope);
      // Verify the worker was deleted
      await assertWorkerDoesNotExist(workerName);
    }
  });

  test("migrate durable object by renaming class", async (scope) => {
    const workerName = `${BRANCH_PREFIX}-test-worker-do-migration-migrate-1`;
    let worker: Worker | undefined = undefined;
    try {
      // First create the worker with the original Counter class
      worker = await Worker(workerName, {
        name: workerName,
        script: doMigrationWorkerScriptV1,
        format: "esm",
      });

      // Apply to create the worker first
      expect(worker.id).toBeTruthy();
      expect(worker.name).toEqual(workerName);

      // Create a stable DO namespace with the original Counter class
      const counterNamespace = new DurableObjectNamespace(
        "test-counter-namespace",
        {
          className: "Counter",
          scriptName: workerName,
        }
      );

      // Update worker with the original Counter binding
      worker = await Worker(workerName, {
        name: workerName,
        script: doMigrationWorkerScriptV1,
        format: "esm",
        bindings: {
          COUNTER: counterNamespace,
        },
      });

      expect(worker.bindings).toBeDefined();

      // Now update the namespace to use CounterV2 class
      const updatedNamespace = new DurableObjectNamespace(
        "test-counter-namespace",
        {
          className: "CounterV2",
          scriptName: workerName,
        }
      );

      // Update worker with the migrated binding
      worker = await Worker(workerName, {
        name: workerName,
        script: doMigrationWorkerScriptV2,
        format: "esm",
        bindings: {
          COUNTER: updatedNamespace,
        },
      });

      expect(worker.bindings).toBeDefined();
    } finally {
      await destroy(scope);
      await assertWorkerDoesNotExist(workerName);
    }
  });

  test("add environment variables to worker with durable object", async (scope) => {
    const workerName = `${BRANCH_PREFIX}-test-worker-do-with-env-doenv-1`;

    let worker: Worker | undefined = undefined;
    try {
      // First create a worker with a Durable Object but no env vars
      worker = await Worker(workerName, {
        name: workerName,
        script: durableObjectWorkerScript,
        format: "esm",
      });

      expect(worker.id).toBeTruthy();
      expect(worker.name).toEqual(workerName);

      // Create a Durable Object namespace
      const counterNamespace = new DurableObjectNamespace(
        "test-counter-env-namespace",
        {
          className: "Counter",
          scriptName: workerName,
        }
      );

      // Update the worker with the DO binding
      worker = await Worker(workerName, {
        name: workerName,
        script: durableObjectWorkerScript,
        format: "esm",
        bindings: {
          COUNTER: counterNamespace,
        },
      });

      // Apply the worker with binding
      expect(worker.bindings).toBeDefined();
      expect(worker.env).toBeUndefined();

      // Now update the worker by adding environment variables
      worker = await Worker(workerName, {
        name: workerName,
        script: durableObjectWorkerScript,
        format: "esm",
        bindings: {
          COUNTER: counterNamespace,
        },
        env: {
          API_SECRET: "test-secret-123",
          DEBUG_MODE: "true",
        },
      });

      expect(worker.bindings).toBeDefined();
      expect(worker.env).toBeDefined();
      expect(worker.env?.API_SECRET).toEqual("test-secret-123");
      expect(worker.env?.DEBUG_MODE).toEqual("true");
    } finally {
      await destroy(scope);
      await assertWorkerDoesNotExist(workerName);
    }
  });

  test("create and delete worker with R2 bucket binding", async (scope) => {
    const workerName = `${BRANCH_PREFIX}-test-worker-r2-binding-r2-1`;

    // Create a test R2 bucket
    let testBucket: R2Bucket | undefined;

    let worker: Worker<{ STORAGE: R2Bucket }> | undefined;

    try {
      testBucket = await R2Bucket("test-bucket", {
        name: `${BRANCH_PREFIX.toLowerCase()}-test-r2-bucket`,
        allowPublicAccess: false,
      });

      // Create a worker with the R2 bucket binding
      worker = await Worker(workerName, {
        name: workerName,
        script: r2WorkerScript,
        format: "esm",
        url: true, // Enable workers.dev URL to test the worker
        bindings: {
          STORAGE: testBucket,
        },
      });

      expect(worker.id).toBeTruthy();
      expect(worker.name).toEqual(workerName);
      expect(worker.bindings).toBeDefined();
      expect(worker.bindings!.STORAGE).toBeDefined();

      // Wait for the worker to be available
      await new Promise((resolve) => setTimeout(resolve, 3000));

      if (worker.url) {
        // Test that the R2 binding is accessible in the worker
        const response = await fetch(`${worker.url}/r2-info`);
        expect(response.status).toEqual(200);
        const data = (await response.json()) as {
          hasR2: boolean;
          bucketName: string;
        };
        expect(data.hasR2).toEqual(true);
      }
    } finally {
      await destroy(scope);
      await assertWorkerDoesNotExist(workerName);
    }
  });

  // Test for static assets
  test("create and test worker with static assets", async (scope) => {
    const workerName = `${BRANCH_PREFIX}-test-worker-assets`;
    let tempDir: string | undefined = undefined;

    try {
      // Create a temporary directory to store test assets
      tempDir = path.join(".out", "alchemy-assets-test");

      await fs.rm(tempDir, { recursive: true, force: true });

      // Ensure directory exists with proper permissions
      await fs.mkdir(tempDir, { recursive: true });

      // Create test files in the temporary directory
      const testContent = "Hello from static assets!";
      const cssContent = "body { color: blue; }";
      const jsonContent = JSON.stringify({
        message: "Hello from JSON",
        timestamp: Date.now(),
      });

      // Create a subdirectory with additional files
      const subDir = path.join(tempDir, "data");
      await Promise.all([
        fs.writeFile(path.join(tempDir, "index.html"), testContent),
        fs.writeFile(path.join(tempDir, "styles.css"), cssContent),
        fs.mkdir(subDir, { recursive: true }),
      ]);
      await fs.writeFile(path.join(subDir, "config.json"), jsonContent);

      // Create assets resource
      const assets = await Assets("static-assets", {
        path: tempDir,
      });

      // Create a worker that uses ESM format and serves static assets
      const workerWithAssetsScript = `
        export default {
          async fetch(request, env, ctx) {
            const url = new URL(request.url);

            if (url.pathname.startsWith("/api/")) {
              return new Response("Worker with assets is running!", { 
                status: 200,
                headers: { 'Content-Type': 'text/plain' }
              });
            }
            try {
              return env.ASSETS.fetch(request);
            } catch (err) {
              console.log(err);
              return new Response(\`\${err}\`, { status: 404 });
            }
          }
        };
      `;

      // Create the worker with assets binding
      const worker = await Worker(workerName, {
        name: workerName,
        script: workerWithAssetsScript,
        format: "esm",
        url: true, // Enable workers.dev URL to test the worker
        bindings: {
          ASSETS: assets,
        },
      });

      expect(worker.id).toBeTruthy();
      expect(worker.name).toEqual(workerName);
      expect(worker.url).toBeTruthy();
      expect(worker.bindings?.ASSETS).toBeTruthy();

      // Wait for the worker to be available and assets to be ready
      await new Promise((resolve) => setTimeout(resolve, 500));

      if (worker.url) {
        async function get(url: string) {
          const response = await fetch(url);
          if (response.status !== 200) {
            console.log(
              response.status,
              response.statusText,
              await response.text()
            );
          }
          expect(response.status).toEqual(200);
          const text = await response.text();
          return text;
        }

        // Test that the static assets are accessible
        const indexText = await get(`${worker.url}/index.html`);
        expect(indexText).toEqual(testContent);

        // Test the worker's main handler
        // should route to index.html
        const mainText = await get(worker.url);
        expect(mainText).toEqual("Hello from static assets!");

        // Test CSS file
        const cssText = await get(`${worker.url}/styles.css`);
        expect(cssText).toEqual(cssContent);

        // Test file in subdirectory
        const jsonData = JSON.parse(
          await get(`${worker.url}/data/config.json`)
        );
        expect(jsonData.message).toEqual("Hello from JSON");

        const apiCall = await get(`${worker.url}/api/data`);
        expect(apiCall).toEqual("Worker with assets is running!");
      }
    } catch (err) {
      throw err;
    } finally {
      // Clean up temporary directory
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true });
      }

      await destroy(scope);
      // Verify the worker was deleted
      await assertWorkerDoesNotExist(workerName);
    }
  });

  // Test for binding a workflow to a worker
  test("create and delete worker with workflow binding", async (scope) => {
    const workerName = `${BRANCH_PREFIX}-test-worker-workflow`;

    // Sample worker script with workflow handler - updated to match Cloudflare Workflows pattern
    const workflowWorkerScript = `
      // Workflow definition for email notifications
      export class EmailNotifier {
        constructor(state, env) {
          this.state = state;
          this.env = env;
        }
        
        async run(event, step) {
          // Process order data from event payload
          const orderDetails = await step.do('process-order', async () => {
            console.log("Processing order", event.payload);
            return { 
              success: true, 
              orderId: event.payload.orderId, 
              message: "Order processed successfully"
            };
          });
          
          return orderDetails;
        }
      }

      // Workflow definition for order processing
      export class OrderProcessor {
        constructor(state, env) {
          this.state = state;
          this.env = env;
        }
        
        async run(event, step) {
          // Process shipping data
          const shippingDetails = await step.do('process-shipping', async () => {
            console.log("Processing shipping", event.payload);
            return { 
              success: true, 
              shipmentId: event.payload.shipmentId, 
              message: "Shipment scheduled successfully"
            };
          });
          
          return shippingDetails;
        }
      }

      export default {
        async fetch(request, env, ctx) {
          const url = new URL(request.url);
          
          // Add endpoints to trigger workflows for testing
          if (url.pathname === '/trigger-email-workflow') {
            try {
              // Get workflow binding
              const workflow = env.EMAIL_WORKFLOW;
              
              if (!workflow) {
                return new Response(JSON.stringify({ error: "No email workflow binding found" }), { 
                  status: 500,
                  headers: { 'Content-Type': 'application/json' }
                });
              }
              
              // Create a workflow instance with parameters
              const params = { orderId: "test-123", amount: 99.99 };
              const instance = await workflow.create(params);
              
              return Response.json({
                id: instance.id,
                details: await instance.status(),
                success: true,
                orderId: params.orderId,
                message: "Order processed successfully"
              });
            } catch (error) {
              console.error("Error triggering email workflow:", error);
              return new Response(JSON.stringify({ error: error.message || "Unknown error" }), { 
                status: 500,
                headers: { 'Content-Type': 'application/json' }
              });
            }
          }
          
          // Endpoint for the order workflow
          if (url.pathname === '/trigger-order-workflow') {
            try {
              // Get workflow binding
              const workflow = env.ORDER_WORKFLOW;
              
              if (!workflow) {
                return new Response(JSON.stringify({ error: "No order workflow binding found" }), { 
                  status: 500,
                  headers: { 'Content-Type': 'application/json' }
                });
              }
              
              // Create a workflow instance with parameters
              const params = { shipmentId: "ship-456", carrier: "FastShip" };
              const instance = await workflow.create(params);
              
              return Response.json({
                id: instance.id,
                details: await instance.status(),
                success: true,
                shipmentId: params.shipmentId,
                message: "Shipment scheduled successfully"
              });
            } catch (error) {
              console.error("Error triggering order workflow:", error);
              return new Response(JSON.stringify({ error: error.message || "Unknown error" }), { 
                status: 500,
                headers: { 'Content-Type': 'application/json' }
              });
            }
          }
          
          return new Response('Worker with workflow bindings!', { status: 200 });
        }
      };
    `;

    let worker: Worker | undefined = undefined;
    try {
      // Create a workflow instance
      const emailWorkflow = new Workflow("email-notifier", {
        className: "EmailNotifier",
        workflowName: "email-notification-workflow",
      });

      // Create a worker with the workflow binding
      worker = await Worker(workerName, {
        name: workerName,
        script: workflowWorkerScript,
        format: "esm",
        bindings: {
          EMAIL_WORKFLOW: emailWorkflow,
        },
        url: true, // Enable workers.dev URL to test the workflow
      });

      expect(worker.id).toBeTruthy();
      expect(worker.name).toEqual(workerName);
      expect(worker.bindings).toBeDefined();
      expect(worker.url).toBeTruthy();

      // Test triggering the first workflow
      const response = await fetch(`${worker.url!}/trigger-email-workflow`);
      const result = await response.json();
      console.log("Email workflow response:", result);

      expect(response.status).toEqual(200);
      expect(result.success).toEqual(true);
      expect(result.orderId).toEqual("test-123");
      expect(result.message).toEqual("Order processed successfully");
      // Verify the instance ID is not empty
      expect(result.id).toBeTruthy();
      expect(typeof result.id).toBe("string");
      expect(result.id.length).toBeGreaterThan(0);
      // Verify the details contain valid status
      expect(result.details).toBeDefined();
      expect(result.details.status).toBeTruthy();

      // Create a new workflow binding and update the worker
      const orderWorkflow = new Workflow("order-processor", {
        className: "OrderProcessor",
        workflowName: "order-processing-workflow",
      });

      // Update the worker with multiple workflow bindings
      worker = await Worker(workerName, {
        name: workerName,
        script: workflowWorkerScript,
        format: "esm",
        bindings: {
          EMAIL_WORKFLOW: emailWorkflow,
          ORDER_WORKFLOW: orderWorkflow,
        },
        url: true,
      });

      expect(worker.bindings).toBeDefined();
      expect(Object.keys(worker.bindings || {})).toHaveLength(2);

      // Test triggering the second workflow
      const orderResponse = await fetch(
        `${worker.url!}/trigger-order-workflow`
      );
      const orderResult = await orderResponse.json();
      console.log("Order workflow response:", orderResult);

      expect(orderResponse.status).toEqual(200);
      expect(orderResult.success).toEqual(true);
      expect(orderResult.shipmentId).toEqual("ship-456");
      expect(orderResult.message).toEqual("Shipment scheduled successfully");
      // Verify the instance ID is not empty
      expect(orderResult.id).toBeTruthy();
      expect(typeof orderResult.id).toBe("string");
      expect(orderResult.id.length).toBeGreaterThan(0);
      // Verify the details contain valid status
      expect(orderResult.details).toBeDefined();
      expect(orderResult.details.status).toBeTruthy();
    } finally {
      // Explicitly destroy resources since destroy: false is set
      await destroy(scope);
      // Verify the worker was deleted
      await assertWorkerDoesNotExist(workerName);
    }
  });
});
