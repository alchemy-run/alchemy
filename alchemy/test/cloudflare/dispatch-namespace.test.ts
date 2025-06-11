import { describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { createCloudflareApi } from "../../src/cloudflare/api.ts";
import { DispatchNamespace } from "../../src/cloudflare/dispatch-namespace.ts";
import { Worker } from "../../src/cloudflare/worker.ts";
import { BRANCH_PREFIX } from "../util.ts";
import { fetchAndExpectOK } from "./fetch-utils.ts";

import "../../src/test/vitest.ts";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe("Dispatch Namespace Resource", () => {
  const testId = `${BRANCH_PREFIX}-test-dispatch`;

  test("create, update, and delete dispatch namespace", async (scope) => {
    let dispatchNamespace: DispatchNamespace | undefined;
    const namespaceName = `${BRANCH_PREFIX}-test-dispatch`;
    try {
      dispatchNamespace = await DispatchNamespace(testId, {
        adopt: true,
        namespace: namespaceName,
      });

      expect(dispatchNamespace.namespace).toEqual(namespaceName);
      expect(dispatchNamespace.type).toEqual("dispatch_namespace");

      // Verify namespace was created
      await assertDispatchNamespaceExists(dispatchNamespace.namespace);

      // Update the dispatch namespace (should be a no-op for namespaces)
      dispatchNamespace = await DispatchNamespace(testId, {
        namespace: namespaceName,
      });

      expect(dispatchNamespace.namespace).toEqual(namespaceName);
    } finally {
      await alchemy.destroy(scope);
      if (dispatchNamespace) {
        // Verify namespace was deleted
        await assertDispatchNamespaceNotExists(dispatchNamespace.namespace);
      }
    }
  });

  test("adopt existing namespace", async (scope) => {
    let dispatchNamespace: DispatchNamespace | undefined;
    const namespaceName = `${testId}-adopt`;
    try {
      dispatchNamespace = await DispatchNamespace("dispatch-ns", {
        namespace: namespaceName,
        adopt: true,
      });

      await alchemy.run("nested", async () => {
        const adoptedNamespace = await DispatchNamespace("dispatch-ns", {
          namespace: namespaceName,
          adopt: true,
        });

        expect(adoptedNamespace.namespace).toEqual(
          dispatchNamespace!.namespace,
        );
      });
    } finally {
      await alchemy.destroy(scope);
      if (dispatchNamespace) {
        await assertDispatchNamespaceNotExists(dispatchNamespace.namespace);
      }
    }
  });

  test("comprehensive dispatch namespace and worker integration", async (scope) => {
    const workerName = `${BRANCH_PREFIX}-target-worker`;
    const dispatcherWorkerName = `${BRANCH_PREFIX}-dispatcher-worker`;
    const namespaceName = `${BRANCH_PREFIX}-comprehensive-test`;

    let targetWorker: Worker | undefined;
    let dispatcherWorker: Worker | undefined;
    let dispatchNamespace: DispatchNamespace | undefined;

    try {
      // 1. Create a dispatch namespace
      dispatchNamespace = await DispatchNamespace("test-dispatch-namespace", {
        namespace: namespaceName,
        adopt: true,
      });

      // 2. Create a worker in the dispatch namespace
      targetWorker = await Worker(workerName, {
        name: workerName,
        script: `
          export default {
            async fetch(request, env, ctx) {
              return new Response('Hello from dispatch namespace!', { status: 200 });
            }
          }
        `,
        dispatchNamespace: dispatchNamespace,
        url: false,
      });

      // 3. Create a worker bound to the namespace (dispatcher)
      dispatcherWorker = await Worker(dispatcherWorkerName, {
        name: dispatcherWorkerName,
        script: `
          export default {
            async fetch(request, env, ctx) {
              // Call the worker through the dispatch namespace
              const targetResponse = await env.NAMESPACE.get('${workerName}').fetch(request);
              
              const text = await targetResponse.text();
              return new Response(\`Dispatch response: \${text}\`, { status: 200 });
            }
          }
        `,
        bindings: {
          NAMESPACE: dispatchNamespace,
        },
        url: true,
      });

      // 4. Execute fetchAndExpectOK against the dispatcher and ensure it works at runtime
      const response = await fetchAndExpectOK(dispatcherWorker.url!);
      const text = await response.text();
      expect(text).toEqual("Dispatch response: Hello from dispatch namespace!");
    } finally {
      await alchemy.destroy(scope);
      if (targetWorker) {
        await assertWorkerDoesNotExist(targetWorker.name);
      }
      if (dispatcherWorker) {
        await assertWorkerDoesNotExist(dispatcherWorker.name);
      }
      if (dispatchNamespace) {
        await assertDispatchNamespaceNotExists(dispatchNamespace.namespace);
      }
    }
  });

  async function assertDispatchNamespaceExists(
    namespace: string,
  ): Promise<void> {
    const api = await createCloudflareApi();
    const response = await api.get(
      `/accounts/${api.accountId}/workers/dispatch/namespaces/${namespace}`,
    );

    expect(response.status).toEqual(200);
  }

  async function assertDispatchNamespaceNotExists(
    namespace: string,
  ): Promise<void> {
    const api = await createCloudflareApi();
    const response = await api.get(
      `/accounts/${api.accountId}/workers/dispatch/namespaces/${namespace}`,
    );

    expect(response.status).toEqual(404);
  }

  async function assertWorkerDoesNotExist(workerName: string): Promise<void> {
    const api = await createCloudflareApi();
    const response = await api.get(
      `/accounts/${api.accountId}/workers/scripts/${workerName}`,
    );

    expect(response.status).toEqual(404);
  }
});
