import { describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { createCloudflareApi } from "../../src/cloudflare/api.ts";
import { DispatchNamespace } from "../../src/cloudflare/dispatch-namespace.ts";
import { Worker } from "../../src/cloudflare/worker.ts";
import { BRANCH_PREFIX } from "../util.ts";

import "../../src/test/vitest.ts";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe("Dispatch Namespace Resource", () => {
  const testId = `${BRANCH_PREFIX}-test-dispatch`;

  test("create, update, and delete dispatch namespace", async (scope) => {
    let dispatchNamespace: DispatchNamespace | undefined;
    const namespaceName = `claude-main-test-namespace-dispatch`;
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
    const namespaceName = `claude-main-adopt-test`;
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
      await assertDispatchNamespaceNotExists(dispatchNamespace!.namespace);
    }
  });

  test("adopt existing namespace with delete false", async (scope) => {
    let dispatchNamespace: DispatchNamespace | undefined;
    const namespaceName = `claude-main-adopt-no-delete`;
    try {
      dispatchNamespace = await DispatchNamespace("dispatch-ns", {
        namespace: namespaceName,
        adopt: true,
      });

      await alchemy.run("nested", async (scope) => {
        const adoptedNamespace = await DispatchNamespace("dispatch-ns", {
          namespace: namespaceName,
          adopt: true,
          delete: false,
        });

        expect(adoptedNamespace.namespace).toEqual(
          dispatchNamespace!.namespace,
        );
        await alchemy.destroy(scope);
        await assertDispatchNamespaceExists(adoptedNamespace.namespace);
      });
    } finally {
      await alchemy.destroy(scope);
      await assertDispatchNamespaceNotExists(dispatchNamespace!.namespace);
    }
  });

  test("create worker with dispatch namespace", async (scope) => {
    const workerName = `${BRANCH_PREFIX}-test-worker-dispatch`;
    const namespaceName = `claude-main-worker-namespace`;

    let worker: Worker | undefined;
    let dispatchNamespace: DispatchNamespace | undefined;
    try {
      // Create a dispatch namespace
      dispatchNamespace = await DispatchNamespace("test-dispatch-namespace", {
        namespace: namespaceName,
      });

      // Create a worker in the dispatch namespace
      worker = await Worker(workerName, {
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

      expect(worker.name).toEqual(workerName);
      expect(worker.dispatchNamespace).toEqual(dispatchNamespace);

      // Verify worker was deployed to dispatch namespace
      await assertWorkerInDispatchNamespace(namespaceName, workerName);
    } finally {
      await alchemy.destroy(scope);
      if (worker) {
        await assertWorkerDoesNotExist(worker.name);
      }
      if (dispatchNamespace) {
        await assertDispatchNamespaceNotExists(dispatchNamespace.namespace);
      }
    }
  });

  test("create worker with dispatch namespace binding", async (scope) => {
    const workerName = `${BRANCH_PREFIX}-test-worker-dispatch-binding`;
    const namespaceName = `claude-main-binding-namespace`;

    let worker: Worker | undefined;
    let dispatchNamespace: DispatchNamespace | undefined;
    try {
      // Create a dispatch namespace
      dispatchNamespace = await DispatchNamespace(
        "test-dispatch-namespace-binding",
        {
          namespace: namespaceName,
        },
      );

      // Create a worker with dispatch namespace as binding
      worker = await Worker(workerName, {
        name: workerName,
        script: `
          export default {
            async fetch(request, env, ctx) {
              // NAMESPACE binding should be available
              return new Response('Hello with dispatch namespace binding!', { status: 200 });
            }
          }
        `,
        bindings: {
          NAMESPACE: dispatchNamespace,
        },
        url: false,
      });

      expect(worker.name).toEqual(workerName);
      expect(worker.bindings.NAMESPACE).toBeDefined();
    } finally {
      await alchemy.destroy(scope);
      if (worker) {
        await assertWorkerDoesNotExist(worker.name);
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

  async function assertWorkerInDispatchNamespace(
    namespace: string,
    workerName: string,
  ): Promise<void> {
    const api = await createCloudflareApi();
    const response = await api.get(
      `/accounts/${api.accountId}/workers/dispatch/namespaces/${namespace}/scripts/${workerName}`,
    );

    expect(response.status).toEqual(200);
  }

  async function assertWorkerDoesNotExist(workerName: string): Promise<void> {
    const api = await createCloudflareApi();
    const response = await api.get(
      `/accounts/${api.accountId}/workers/scripts/${workerName}`,
    );

    expect(response.status).toEqual(404);
  }
});
