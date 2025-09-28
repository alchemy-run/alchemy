import { describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { Worker } from "../../src/cloudflare/index.ts";
import { destroy } from "../../src/destroy.ts";
import "../../src/test/vitest.ts";
import { BRANCH_PREFIX } from "../util.ts";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe("Worker tail consumers", () => {
  const testId = `${BRANCH_PREFIX}-tail-consumer`;

  test("worker with tail consumers configuration", async (scope) => {
    try {
      // Create a consumer worker first
      const consumerWorker = await Worker(`${testId}-consumer`, {
        name: `${testId}-consumer`,
        entrypoint: `${__dirname}/test-handlers/tail-handler.ts`,
        adopt: true,
      });

      // Create a producer worker and implement tail consumers
      const producerWorker = await Worker(`${testId}-producer`, {
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

  test("worker directly referenced by tail consumers", async (scope) => {
    try {
      // Create a consumer worker first
      const consumerWorker = await Worker(`${testId}-consumer`, {
        name: `${testId}-consumer`,
        entrypoint: `${__dirname}/test-handlers/tail-handler.ts`,
        adopt: true,
      });

      // Create a producer worker and directly reference the consumer worker
      const producerWorker = await Worker(`${testId}-producer`, {
        name: `${testId}-producer`,
        entrypoint: `${__dirname}/test-handlers/basic-fetch.ts`,
        tailConsumers: [consumerWorker],
        adopt: true,
      });

      expect(producerWorker.tailConsumers).toMatchObject([consumerWorker]);
      expect(producerWorker.name).toBeTruthy();
    } finally {
      await destroy(scope);
    }
  });
});
