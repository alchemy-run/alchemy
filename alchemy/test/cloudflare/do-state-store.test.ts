import { afterAll, describe } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { createCloudflareApi } from "../../src/cloudflare/api.ts";
import { DOStateStore } from "../../src/cloudflare/do-state-store/index.ts";
import {
  assertWorkerDoesNotExist,
  deleteWorker,
} from "../../src/cloudflare/worker.ts";
import { File } from "../../src/fs/file.ts";
import "../../src/test/vitest.ts";
import { BRANCH_PREFIX } from "../util.ts";

const workerName = `alchemy-state-${BRANCH_PREFIX}`;

const api = await createCloudflareApi();

const test = alchemy.test(import.meta, {
  stateStore: (scope) =>
    new DOStateStore(scope, {
      worker: {
        name: workerName,
      },
    }),
});

afterAll(async () => {
  await deleteWorker(api, { workerName });
  await assertWorkerDoesNotExist(api, workerName);
});

describe("DOStateStore", () => {
  test("should initialize with lazy worker creation", async (scope) => {
    try {
      await File("file", {
        content: "test",
        path: `/tmp/alchemy-state-store-test${BRANCH_PREFIX}`,
      });
    } finally {
      alchemy.destroy(scope);
    }
  });
});
