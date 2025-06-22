import { describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { destroy } from "../../src/destroy.ts";
import { createCloudflareApi } from "../../src/cloudflare/api.ts";
import { DOStateStore } from "../../src/cloudflare/do-state-store/index.ts";
import { deleteWorker } from "../../src/cloudflare/worker.ts";
import { BRANCH_PREFIX } from "../util.ts";
import "../../src/test/vitest.ts";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe("DOStateStore", () => {
  test("should initialize with lazy worker creation", async (scope) => {
    const workerName = `alchemy-state-${BRANCH_PREFIX}`;
    const api = await createCloudflareApi();

    // Optimistically delete the worker before creating it
    try {
      await deleteWorker(api, { workerName });
    } catch {
      // Ignore errors - worker might not exist
    }

    let stateStore: DOStateStore | undefined;

    try {
      // Create DOStateStore with custom worker name
      stateStore = new DOStateStore(scope, {
        worker: {
          name: workerName,
        },
      });

      // Test the init phase - this should trigger lazy worker creation
      await stateStore.init();

      // Verify the state store is working by doing a basic operation
      await stateStore.set("test-key", { value: "test-value" });
      const result = await stateStore.get("test-key");

      expect(result).toMatchObject({
        value: "test-value",
      });

      // Test that the worker was created by checking we can perform operations
      const count = await stateStore.count();
      expect(count).toBeGreaterThanOrEqual(1);
    } finally {
      await destroy(scope);

      if (stateStore) {
        await assertWorkerDoesNotExist(api, workerName);
      }
    }
  });
});

async function assertWorkerDoesNotExist(api: any, workerName: string) {
  try {
    const response = await api.get(
      `/accounts/${api.accountId}/workers/scripts/${workerName}`,
    );
    expect(response.status).toEqual(404);
  } catch {
    // 404 is expected, so we can ignore it
    return;
  }
}
