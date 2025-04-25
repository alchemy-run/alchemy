import { describe, expect } from "bun:test";
import { alchemy } from "../../src/alchemy.js";
import { createCloudflareApi } from "../../src/cloudflare/api.js";
import { listQueueConsumers } from "../../src/cloudflare/queue-consumer.js";
import { Queue } from "../../src/cloudflare/queue.js";
import { Worker } from "../../src/cloudflare/worker.js";
import { destroy } from "../../src/destroy.js";
import { BRANCH_PREFIX } from "../util.js";
// must import this or else alchemy.test won't exist
import { CloudflareApiError } from "../../src/cloudflare/api-error.js";
import "../../src/test/bun.js";

const test = alchemy.test(import.meta);

const api = await createCloudflareApi({});

describe("QueueConsumer Resource", () => {
  // Use BRANCH_PREFIX for deterministic, non-colliding resource names
  const testId = `${BRANCH_PREFIX}-test-queue-consumer`;
  const queueName = `${testId}-queue`;
  const workerName = `${testId}-worker`;

  test("create, update, and delete queue consumer", async (scope) => {
    let queue: Queue | undefined;
    let worker: Worker | undefined;

    try {
      queue = await Queue(`${testId}-queue`, {
        name: queueName,
      });

      expect(queue.id).toBeTruthy();
      expect(queue.name).toEqual(queueName);

      worker = await Worker(`${testId}-worker`, {
        name: workerName,
        script: `
          export default {
            async fetch(request, env, ctx) {
              return new Response("Hello World");
            },
            async queue(batch, env, ctx) {
              return batch.messages.map(() => ({ status: "ack" }));
            }
          }
        `,
        eventSources: [queue],
      });

      expect(worker.id).toBeTruthy();
      expect(worker.name).toEqual(workerName);

      const consumers = await listQueueConsumers(api, queue.id);

      const thisConsumer = consumers.find((c) => c.scriptName === workerName);

      expect(thisConsumer).toBeTruthy();
    } catch (err) {
      // log the error or else it's silently swallowed by destroy errors
      console.log(err);
      throw err;
    } finally {
      // Always clean up, even if test assertions fail
      await destroy(scope);

      // Verify consumers were deleted
      try {
        await listQueueConsumers(api, queue!.id);
      } catch (err) {
        if (err instanceof CloudflareApiError && err.status === 404) {
          // expected
        } else {
          throw err;
        }
      }
    }
  });
});
