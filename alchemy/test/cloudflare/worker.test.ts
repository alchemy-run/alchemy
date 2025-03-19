import { describe, expect, test } from "bun:test";
import { apply } from "../../src/apply";
import { createCloudflareApi } from "../../src/cloudflare/api";
import { DurableObjectNamespace } from "../../src/cloudflare/durable-object-namespace";
import { KVNamespace } from "../../src/cloudflare/kv-namespace";
import { Worker } from "../../src/cloudflare/worker";
import { destroy } from "../../src/destroy";
import { BRANCH_PREFIX } from "../util";

describe("Worker Resource", () => {
  // Use a fixed name for the test worker
  const testName = `${BRANCH_PREFIX}-test-worker`;
  const esmTestName = `${BRANCH_PREFIX}-test-worker-esm`;
  const formatConversionTestName = `${BRANCH_PREFIX}-test-worker-format-conversion`;
  const doBindingTestName = `${BRANCH_PREFIX}-test-worker-do-binding`;
  const kvBindingTestName = `${BRANCH_PREFIX}-test-worker-kv-binding`;
  const multiBindingsTestName = `${BRANCH_PREFIX}-test-worker-multi-bindings`;
  const envVarsTestName = `${BRANCH_PREFIX}-test-worker-env-vars`;

  // Add a new test name for DO migration
  const doMigrationTestName = `${BRANCH_PREFIX}-test-worker-do-migration`;

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

  test("create, update, and delete worker (CJS format)", async () => {
    // Create a worker with an explicit name
    const worker = new Worker(testName, {
      name: `${BRANCH_PREFIX}-${testName}`, // Explicitly provide the name with BRANCH_PREFIX
      script: workerScript,
      format: "cjs",
    });

    // Apply to create the worker
    const output = await apply(worker);
    expect(output.id).toBeTruthy();
    expect(output.name).toEqual(`${BRANCH_PREFIX}-${testName}`);
    expect(output.format).toEqual("cjs");

    // Update the worker with a new script
    const updatedScript = `
      addEventListener('fetch', event => {
        event.respondWith(new Response('Hello updated world!', { status: 200 }));
      });
    `;

    const updatedWorker = new Worker(testName, {
      name: `${BRANCH_PREFIX}-${testName}`, // Explicitly provide the name with BRANCH_PREFIX
      script: updatedScript,
      format: "cjs",
    });

    const updateOutput = await apply(updatedWorker);
    expect(updateOutput.id).toEqual(output.id);

    // Delete the worker
    await destroy(worker);

    // Verify the worker was deleted by directly checking with the Cloudflare API
    const api = await createCloudflareApi();
    const response = await api.get(
      `/accounts/${api.accountId}/workers/scripts/${testName}`,
    );

    // Should be a 404 if properly deleted
    expect(response.status).toEqual(404);
  });

  test("create, update, and delete worker (ESM format)", async () => {
    // Create a worker with ESM format
    const worker = new Worker(esmTestName, {
      name: `${BRANCH_PREFIX}-${esmTestName}`,
      script: esmWorkerScript,
      format: "esm", // Explicitly using ESM
    });

    // Apply to create the worker
    const output = await apply(worker);
    expect(output.id).toBeTruthy();
    expect(output.name).toEqual(`${BRANCH_PREFIX}-${esmTestName}`);
    expect(output.format).toEqual("esm");

    // Update the worker with a new ESM script
    const updatedEsmScript = `
      export default {
        async fetch(request, env, ctx) {
          return new Response('Hello updated ESM world!', { status: 200 });
        }
      };
    `;

    const updatedWorker = new Worker(esmTestName, {
      name: `${BRANCH_PREFIX}-${esmTestName}`,
      script: updatedEsmScript,
      format: "esm",
    });

    const updateOutput = await apply(updatedWorker);
    expect(updateOutput.id).toEqual(output.id);

    // Delete the worker
    await destroy(worker);

    // Verify the worker was deleted
    const api = await createCloudflareApi();
    const response = await api.get(
      `/accounts/${api.accountId}/workers/scripts/${esmTestName}`,
    );
    expect(response.status).toEqual(404);
  });

  test("convert between ESM and CJS formats", async () => {
    // First create with ESM format
    let worker = new Worker(formatConversionTestName, {
      name: formatConversionTestName,
      script: esmWorkerScript,
      format: "esm",
    });

    // Apply to create the worker with ESM
    let output = await apply(worker);
    expect(output.format).toEqual("esm");

    // Update to CJS format
    worker = new Worker(formatConversionTestName, {
      name: formatConversionTestName,
      script: workerScript,
      format: "cjs",
    });

    // Apply to update to CJS
    output = await apply(worker);
    expect(output.format).toEqual("cjs");

    // Update back to ESM format
    worker = new Worker(formatConversionTestName, {
      name: formatConversionTestName,
      script: esmWorkerScript,
      format: "esm",
    });

    // Apply to update back to ESM
    output = await apply(worker);
    expect(output.format).toEqual("esm");

    // Clean up
    await destroy(worker);

    // Verify deletion
    const api = await createCloudflareApi();
    const response = await api.get(
      `/accounts/${api.accountId}/workers/scripts/${formatConversionTestName}`,
    );
    expect(response.status).toEqual(404);
  });

  test("fails when creating a worker with a duplicate name", async () => {
    // Define fixed names for this test
    const duplicateTestName = `${BRANCH_PREFIX}-test-worker-duplicate`;

    // First, create a worker successfully
    const firstWorker = new Worker(duplicateTestName, {
      name: duplicateTestName,
      script: workerScript,
      format: "cjs",
    });

    await apply(firstWorker);

    // Try to create another worker with the same name, which should fail
    const duplicateWorker = new Worker("different-resource-id", {
      name: duplicateTestName, // Same name as firstWorker
      script: workerScript,
      format: "cjs",
    });

    try {
      // Expect the apply call to throw an error about duplicate worker
      await expect(apply(duplicateWorker)).rejects.toThrow(
        `Worker with name '${duplicateTestName}' already exists. Please use a unique name.`,
      );
    } finally {
      await destroy(duplicateWorker);

      // Clean up by deleting the first worker
      await destroy(firstWorker);
    }
  });

  test("create and delete worker with Durable Object binding", async () => {
    try {
      // First create the worker without the DO binding
      const initialWorker = new Worker(doBindingTestName, {
        name: doBindingTestName,
        script: durableObjectWorkerScript,
        format: "esm",
        // No bindings yet
      });

      // Apply to create the worker first
      const initialOutput = await apply(initialWorker);
      expect(initialOutput.id).toBeTruthy();
      expect(initialOutput.name).toEqual(doBindingTestName);

      // Create a Durable Object namespace
      const counterNamespace = new DurableObjectNamespace(
        "test-counter-namespace",
        {
          className: "Counter",
          scriptName: doBindingTestName,
        },
      );

      // Update the worker with the DO binding
      const updatedWorker = new Worker(doBindingTestName, {
        name: doBindingTestName,
        script: durableObjectWorkerScript,
        format: "esm",
        bindings: {
          COUNTER: counterNamespace,
        },
      });

      // Apply the update with the binding
      const output = await apply(updatedWorker);
      expect(output.id).toBeTruthy();
      expect(output.name).toEqual(doBindingTestName);
      expect(output.bindings).toBeDefined();
    } finally {
      // Clean up by deleting the worker
      const cleanupWorker = new Worker(doBindingTestName, {
        name: doBindingTestName,
        script: durableObjectWorkerScript,
        format: "esm",
      });
      await destroy(cleanupWorker);

      // Verify the worker was deleted
      const api = await createCloudflareApi();
      const response = await api.get(
        `/accounts/${api.accountId}/workers/scripts/${doBindingTestName}`,
      );
      expect(response.status).toEqual(404);
    }
  });

  test("create and delete worker with KV Namespace binding", async () => {
    // Create a KV namespace with initial values
    const testKv = new KVNamespace("test-kv-namespace", {
      title: `${BRANCH_PREFIX} Test KV Namespace 2`,
      values: [
        {
          key: "testKey",
          value: "initial-value",
        },
      ],
    });

    // Create a worker with the KV Namespace binding
    const worker = new Worker(kvBindingTestName, {
      name: kvBindingTestName,
      script: kvWorkerScript,
      format: "esm",
      bindings: {
        TEST_KV: testKv,
      },
    });

    // Apply to create the worker
    const output = await apply(worker);
    expect(output.id).toBeTruthy();
    expect(output.name).toEqual(kvBindingTestName);
    expect(output.bindings).toBeDefined();

    // Delete the worker
    await destroy(worker);

    // Also clean up the KV namespace
    await destroy(testKv);

    // Verify the worker was deleted
    const api = await createCloudflareApi();
    const response = await api.get(
      `/accounts/${api.accountId}/workers/scripts/${kvBindingTestName}`,
    );
    expect(response.status).toEqual(404);
  });

  test("create and delete worker with multiple bindings", async () => {
    try {
      // First create the worker without bindings
      const initialWorker = new Worker(multiBindingsTestName, {
        name: multiBindingsTestName,
        script: multiBindingsWorkerScript,
        format: "esm",
      });

      // Apply to create the worker first
      const initialOutput = await apply(initialWorker);
      expect(initialOutput.id).toBeTruthy();
      expect(initialOutput.name).toEqual(multiBindingsTestName);

      // Create a Durable Object namespace
      const counterNamespace = new DurableObjectNamespace(
        "test-counter-namespace",
        {
          className: "Counter",
          scriptName: multiBindingsTestName,
        },
      );

      // Create a KV namespace
      const testKv = new KVNamespace("test-kv-namespace", {
        title: `${BRANCH_PREFIX} Test KV Namespace 1`,
        values: [
          {
            key: "testKey",
            value: "initial-value",
          },
        ],
      });

      // Update the worker with all bindings
      const updatedWorker = new Worker(multiBindingsTestName, {
        name: multiBindingsTestName,
        script: multiBindingsWorkerScript,
        format: "esm",
        bindings: {
          COUNTER: counterNamespace,
          TEST_KV: testKv,
          API_KEY: "test-api-key-value",
        },
      });

      // Apply the update
      const output = await apply(updatedWorker);
      expect(output.id).toBeTruthy();
      expect(output.name).toEqual(multiBindingsTestName);
      expect(output.bindings).toBeDefined();
    } finally {
      // Clean up by deleting the worker
      const cleanupWorker = new Worker(multiBindingsTestName, {
        name: multiBindingsTestName,
        script: multiBindingsWorkerScript,
        format: "esm",
      });
      await destroy(cleanupWorker);

      // Verify the worker was deleted
      const api = await createCloudflareApi();
      const response = await api.get(
        `/accounts/${api.accountId}/workers/scripts/${multiBindingsTestName}`,
      );
      expect(response.status).toEqual(404);
    }
  });

  // Add a new test for environment variables
  test("create and test worker with environment variables", async () => {
    let worker: Worker | undefined = undefined;
    try {
      // Create a worker with environment variables
      worker = new Worker(envVarsTestName, {
        name: envVarsTestName,
        script: envVarsWorkerScript,
        format: "esm",
        env: {
          TEST_API_KEY: "test-api-key-123",
          NODE_ENV: "testing",
          APP_DEBUG: "true",
        },
        url: true, // Enable workers.dev URL to test the worker
      });

      // Apply to create the worker
      const output = await apply(worker);
      expect(output.id).toBeTruthy();
      expect(output.name).toEqual(envVarsTestName);
      expect(output.env).toBeDefined();
      expect(output.env?.TEST_API_KEY).toEqual("test-api-key-123");
      expect(output.env?.NODE_ENV).toEqual("testing");
      expect(output.url).toBeTruthy();

      // Wait for the worker to be available
      await new Promise((resolve) => setTimeout(resolve, 1000));

      if (output.url) {
        // Test that the environment variables are accessible in the worker
        const response = await fetch(`${output.url}/env/TEST_API_KEY`);
        expect(response.status).toEqual(200);
        const text = await response.text();
        expect(text).toEqual("test-api-key-123");

        // Test another environment variable
        const nodeEnvResponse = await fetch(`${output.url}/env/NODE_ENV`);
        expect(nodeEnvResponse.status).toEqual(200);
        const nodeEnvText = await nodeEnvResponse.text();
        expect(nodeEnvText).toEqual("testing");
      }

      // Update the worker with different environment variables
      worker = new Worker(envVarsTestName, {
        name: envVarsTestName,
        script: envVarsWorkerScript,
        format: "esm",
        env: {
          TEST_API_KEY: "updated-key-456",
          NODE_ENV: "production",
          NEW_VAR: "new-value",
        },
        url: true,
      });

      // Apply the update
      const updateOutput = await apply(worker);
      expect(updateOutput.id).toEqual(output.id);
      expect(updateOutput.env?.TEST_API_KEY).toEqual("updated-key-456");
      expect(updateOutput.env?.NODE_ENV).toEqual("production");
      expect(updateOutput.env?.NEW_VAR).toEqual("new-value");
      // APP_DEBUG should no longer be present
      expect(updateOutput.env?.APP_DEBUG).toBeUndefined();

      // Wait for the worker update to propagate
      await new Promise((resolve) => setTimeout(resolve, 5000));

      if (updateOutput.url) {
        // Test that the updated environment variables are accessible
        const response = await fetch(`${updateOutput.url}/env/TEST_API_KEY`);
        expect(response.status).toEqual(200);
        const text = await response.text();
        expect(text).toEqual("updated-key-456");

        // Test new environment variable
        const newVarResponse = await fetch(`${updateOutput.url}/env/NEW_VAR`);
        expect(newVarResponse.status).toEqual(200);
        const newVarText = await newVarResponse.text();
        expect(newVarText).toEqual("new-value");

        // Test that the removed environment variable is no longer accessible
        const removedVarResponse = await fetch(
          `${updateOutput.url}/env/APP_DEBUG`,
        );
        expect(removedVarResponse.status).toEqual(200);
        const removedVarText = await removedVarResponse.text();
        expect(removedVarText).toEqual("undefined");
      }
    } finally {
      if (worker) {
        // Clean up by deleting the worker
        await destroy(worker);

        // Verify the worker was deleted
        const api = await createCloudflareApi();
        const response = await api.get(
          `/accounts/${api.accountId}/workers/scripts/${envVarsTestName}`,
        );
        expect(response.status).toEqual(404);
      }
    }
  });

  test("migrate durable object by renaming class", async () => {
    let initialWorker: Worker | undefined = undefined;
    try {
      // First create the worker with the original Counter class
      initialWorker = new Worker(doMigrationTestName, {
        name: doMigrationTestName,
        script: doMigrationWorkerScriptV1,
        format: "esm",
      });

      // Apply to create the worker first
      const initialOutput = await apply(initialWorker);
      expect(initialOutput.id).toBeTruthy();
      expect(initialOutput.name).toEqual(doMigrationTestName);

      // Create a stable DO namespace with the original Counter class
      const counterNamespace = new DurableObjectNamespace(
        "test-counter-namespace",
        {
          className: "Counter",
          scriptName: doMigrationTestName,
        },
      );

      // Update worker with the original Counter binding
      const workerWithBinding = new Worker(doMigrationTestName, {
        name: doMigrationTestName,
        script: doMigrationWorkerScriptV1,
        format: "esm",
        bindings: {
          COUNTER: counterNamespace,
        },
      });

      // Apply the binding
      const outputWithBinding = await apply(workerWithBinding);
      expect(outputWithBinding.bindings).toBeDefined();

      // Now update the namespace to use CounterV2 class
      const updatedNamespace = new DurableObjectNamespace(
        "test-counter-namespace",
        {
          className: "CounterV2",
          scriptName: doMigrationTestName,
        },
      );

      // Update worker with the migrated binding
      const workerWithMigration = new Worker(doMigrationTestName, {
        name: doMigrationTestName,
        script: doMigrationWorkerScriptV2,
        format: "esm",
        bindings: {
          COUNTER: updatedNamespace,
        },
      });

      // Apply the migration
      const migratedOutput = await apply(workerWithMigration);
      expect(migratedOutput.bindings).toBeDefined();
    } finally {
      if (initialWorker) {
        await destroy(initialWorker);
      }
    }
  });

  test("add environment variables to worker with durable object", async () => {
    // Add a new test name for DO with env vars
    const doWithEnvVarsTestName = `${BRANCH_PREFIX}-test-worker-do-with-env`;

    let worker: Worker | undefined = undefined;
    try {
      // First create a worker with a Durable Object but no env vars
      worker = new Worker(doWithEnvVarsTestName, {
        name: doWithEnvVarsTestName,
        script: durableObjectWorkerScript,
        format: "esm",
      });

      // Apply to create the worker
      const initialOutput = await apply(worker);
      expect(initialOutput.id).toBeTruthy();
      expect(initialOutput.name).toEqual(doWithEnvVarsTestName);

      // Create a Durable Object namespace
      const counterNamespace = new DurableObjectNamespace(
        "test-counter-env-namespace",
        {
          className: "Counter",
          scriptName: doWithEnvVarsTestName,
        },
      );

      // Update the worker with the DO binding
      worker = new Worker(doWithEnvVarsTestName, {
        name: doWithEnvVarsTestName,
        script: durableObjectWorkerScript,
        format: "esm",
        bindings: {
          COUNTER: counterNamespace,
        },
      });

      // Apply the worker with binding
      const outputWithBinding = await apply(worker);
      expect(outputWithBinding.bindings).toBeDefined();
      expect(outputWithBinding.env).toBeUndefined();

      // Now update the worker by adding environment variables
      worker = new Worker(doWithEnvVarsTestName, {
        name: doWithEnvVarsTestName,
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

      // Apply the worker with binding and env vars
      const finalOutput = await apply(worker);
      expect(finalOutput.bindings).toBeDefined();
      expect(finalOutput.env).toBeDefined();
      expect(finalOutput.env?.API_SECRET).toEqual("test-secret-123");
      expect(finalOutput.env?.DEBUG_MODE).toEqual("true");
    } finally {
      if (worker) {
        // Clean up
        await destroy(worker);

        // Verify the worker was deleted
        const api = await createCloudflareApi();
        const response = await api.get(
          `/accounts/${api.accountId}/workers/scripts/${doWithEnvVarsTestName}`,
        );
        expect(response.status).toEqual(404);
      }
    }
  });
});
