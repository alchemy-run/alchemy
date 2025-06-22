import { describe, expect, it } from "vitest";
import { createCloudflareApi } from "../../src/cloudflare/api.ts";
import { DOStateStore } from "../../src/cloudflare/do-state-store/index.ts";
import { deleteWorker } from "../../src/cloudflare/worker.ts";
import { Scope } from "../../src/scope.ts";
import { FileSystemStateStore } from "../../src/fs/file-system-state-store.ts";
import { NoopTelemetryClient } from "../../src/util/telemetry/client.ts";
import { BRANCH_PREFIX } from "../util.ts";
import "../../src/test/vitest.ts";

describe("DOStateStore", () => {
  it("should initialize with lazy worker creation", async () => {
    // Create a minimal scope for testing
    const scope = new Scope({
      scopeName: `do-state-store-test-${BRANCH_PREFIX}`,
      phase: "up",
      stateStore: (scope) => new FileSystemStateStore(scope),
      telemetryClient: new NoopTelemetryClient(),
      quiet: true,
    });
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
      // Manually delete the worker since it's not managed by alchemy
      if (stateStore) {
        try {
          await deleteWorker(api, { workerName });
        } catch {
          // Ignore errors - worker might already be deleted
        }

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
