import { describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy";
import { Worker } from "../../src/cloudflare";
import { destroy } from "../../src/destroy";
import "../../src/test/vitest";
import { BRANCH_PREFIX } from "../util";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe("Worker tail consumers", () => {
  const testId = `${BRANCH_PREFIX}-tail-consumer`;

  test("worker with tail consumers configuration", async (scope) => {
    let producerWorker: Worker | undefined;
    let consumerWorker: Worker | undefined;

    try {
      // Create a consumer worker first
      consumerWorker = await Worker(`${testId}-consumer`, {
        name: `${testId}-consumer`,
        entrypoint: `${__dirname}/test-handlers/tail-handler.ts`,
        adopt: true,
      });

      // Create a producer worker and implement tail consumers
      producerWorker = await Worker(`${testId}-producer`, {
        name: `${testId}-producer`,
        entrypoint: `${__dirname}/test-handlers/basic-fetch.ts`,
        tailConsumers: [{ service: consumerWorker.name }],
        adopt: true,
      });

      expect(producerWorker.tailConsumers).toEqual([
        { service: consumerWorker.name },
      ]);
      expect(producerWorker.name).toBeTruthy();
    } finally {
      await destroy(scope);
    }
  });
});
