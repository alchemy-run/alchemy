import { describe, expect } from "bun:test";
import { alchemy } from "../../src/alchemy";
import { createCloudflareApi } from "../../src/cloudflare/api";
import { R2Bucket } from "../../src/cloudflare/bucket";
import { DurableObjectNamespace } from "../../src/cloudflare/durable-object-namespace";
import { KVNamespace } from "../../src/cloudflare/kv-namespace";
import { Worker } from "../../src/cloudflare/worker";
import "../../src/test/bun";
import { BRANCH_PREFIX } from "../util";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

async function assertWorkerDoesNotExist(workerName: string) {
  const api = await createCloudflareApi();
  const response = await api.get(
    `/accounts/${api.accountId}/workers/scripts/${workerName}`,
  );
  expect(response.status).toEqual(404);
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
      await alchemy.destroy(scope);
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
      await alchemy.destroy(scope);
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
      await alchemy.destroy(scope);
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
        `Worker with name '${workerName}' already exists. Please use a unique name.`,
      );
    } finally {
      await alchemy.destroy(scope);
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
        },
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
      await alchemy.destroy(scope);
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
      await alchemy.destroy(scope);
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
      },
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
      await alchemy.destroy(scope);
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
      await alchemy.destroy(scope);
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
        },
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
        },
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
      await alchemy.destroy(scope);
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
        },
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
      await alchemy.destroy(scope);
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
      await alchemy.destroy(scope);
      await assertWorkerDoesNotExist(workerName);
    }
  });
});
