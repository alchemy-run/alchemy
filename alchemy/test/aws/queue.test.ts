import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SQSClient,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import { describe, expect } from "bun:test";
import { alchemy } from "../../src/alchemy.js";
import { Queue } from "../../src/aws/queue.js";
import { destroy } from "../../src/destroy.js";
import { BRANCH_PREFIX } from "../util.js";

import "../../src/test/bun.js";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

const sqs = new SQSClient({});

describe("AWS Resources", () => {
  describe("Queue", () => {
    test("create queue", async (scope) => {
      const queueName = `${BRANCH_PREFIX}-alchemy-test-queue`;

      try {
        const queue = await Queue(queueName, {
          queueName,
          fifo: false,
          visibilityTimeout: 30,
          tags: {
            Environment: "test",
          },
        });
        expect(queue.url).toMatch(
          new RegExp(
            `https:\\/\\/sqs\\.[a-z0-9-]+\\.amazonaws\\.com\\/\\d+\\/${queueName}$`,
          ),
        );
        expect(queue.arn).toMatch(
          new RegExp(`^arn:aws:sqs:[a-z0-9-]+:\\d+:${queueName}$`),
        );
        expect(queue.tags).toEqual({
          Environment: "test",
        });

        // Verify queue exists with proper attributes
        const getQueueUrlResponse = await sqs.send(
          new GetQueueUrlCommand({
            QueueName: queueName,
          }),
        );

        const getQueueAttributesResponse = await sqs.send(
          new GetQueueAttributesCommand({
            QueueUrl: getQueueUrlResponse.QueueUrl,
            AttributeNames: ["All"],
          }),
        );

        expect(getQueueAttributesResponse.Attributes?.VisibilityTimeout).toBe(
          "30",
        );
      } finally {
        // Always clean up, even if test assertions fail
        await destroy(scope);

        // Verify queue is gone (this will throw if queue doesn't exist)
        await expect(
          sqs.send(
            new GetQueueUrlCommand({
              QueueName: queueName,
            }),
          ),
        ).rejects.toThrow("The specified queue does not exist");
      }
    });

    test("create fifo queue", async (scope) => {
      // For FIFO queues, the name must end with .fifo suffix
      const queueName = `${BRANCH_PREFIX}-alchemy-test-fifo-queue.fifo`;

      try {
        const queue = await Queue(queueName, {
          queueName,
          fifo: true,
          visibilityTimeout: 30,
          contentBasedDeduplication: true,
          tags: {
            Environment: "test",
          },
        });
        expect(queue.url).toMatch(
          new RegExp(
            `https:\\/\\/sqs\\.[a-z0-9-]+\\.amazonaws\\.com\\/\\d+\\/${queueName.replace(/\./g, "\\.")}$`,
          ),
        );
        expect(queue.fifo).toBe(true);
        expect(queue.contentBasedDeduplication).toBe(true);

        // Verify queue exists with proper attributes
        const getQueueUrlResponse = await sqs.send(
          new GetQueueUrlCommand({
            QueueName: queueName,
          }),
        );

        const getQueueAttributesResponse = await sqs.send(
          new GetQueueAttributesCommand({
            QueueUrl: getQueueUrlResponse.QueueUrl,
            AttributeNames: ["All"],
          }),
        );

        expect(getQueueAttributesResponse.Attributes?.FifoQueue).toBe("true");
        expect(
          getQueueAttributesResponse.Attributes?.ContentBasedDeduplication,
        ).toBe("true");
      } finally {
        // Always clean up, even if test assertions fail
        await destroy(scope);
      }
    });

    test("create queue, send message, delete, and recreate", async (scope) => {
      // Create initial queue
      const queueName = `${BRANCH_PREFIX}-alchemy-test-queue-recreate`;

      try {
        const queue = await Queue(queueName, {
          queueName,
          fifo: false,
          visibilityTimeout: 30,
        });
        expect(queue.arn).toMatch(
          new RegExp(`^arn:aws:sqs:[a-z0-9-]+:\\d+:${queueName}$`),
        );
        expect(queue.url).toMatch(
          new RegExp(
            `^https:\\/\\/sqs\\.[a-z0-9-]+\\.amazonaws\\.com\\/\\d+\\/${queueName}$`,
          ),
        );

        // Send a test message
        const messageResponse = await sqs.send(
          new SendMessageCommand({
            QueueUrl: queue.url,
            MessageBody: "Hello from test!",
          }),
        );
        expect(messageResponse.MessageId).toBeTruthy();

        // Delete the queue
        await destroy(queue);

        // Verify queue is fully deleted by checking if GetQueueUrl throws
        await expect(
          sqs.send(
            new GetQueueUrlCommand({
              QueueName: queueName,
            }),
          ),
        ).rejects.toThrow("The specified queue does not exist");

        // Immediately try to recreate the queue - this should handle the QueueDeletedRecently error
        const recreatedQueue = await Queue(queueName, {
          queueName,
          visibilityTimeout: 30,
          messageRetentionPeriod: 345600,
          tags: {
            Environment: "test",
          },
        });

        expect(recreatedQueue.arn).toMatch(
          new RegExp(`^arn:aws:sqs:[a-z0-9-]+:\\d+:${queueName}$`),
        );
        expect(recreatedQueue.url).toMatch(
          new RegExp(
            `^https:\\/\\/sqs\\.[a-z0-9-]+\\.amazonaws\\.com\\/\\d+\\/${queueName}$`,
          ),
        );
      } finally {
        // In case the initial queue creation or tests fail
        await destroy(scope); // Ignore errors on cleanup
      }
    });
  });
});
