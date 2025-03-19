import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SQSClient,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import { describe, expect, test } from "bun:test";
import { apply } from "../../src/apply";
import { Queue } from "../../src/aws/queue";
import { destroy } from "../../src/destroy";
import { BRANCH_PREFIX } from "../util";

const sqs = new SQSClient({});

describe("AWS Resources", () => {
  describe("Queue", () => {
    test("create queue", async () => {
      const queueName = `${BRANCH_PREFIX}-alchemy-test-queue`;
      const queue = new Queue(queueName, {
        queueName,
        fifo: false,
        visibilityTimeout: 30,
        tags: {
          Environment: "test",
        },
      });

      try {
        const output = await apply(queue);
        expect(output.id).toBe(queueName);
        expect(output.url).toMatch(
          new RegExp(
            `https:\\/\\/sqs\\.[a-z0-9-]+\\.amazonaws\\.com\\/\\d+\\/${queueName}$`,
          ),
        );
        expect(output.arn).toMatch(
          new RegExp(`^arn:aws:sqs:[a-z0-9-]+:\\d+:${queueName}$`),
        );
        expect(output.tags).toEqual({
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
        await destroy(queue);

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

    test("create fifo queue", async () => {
      // For FIFO queues, the name must end with .fifo suffix
      const queueName = `${BRANCH_PREFIX}-alchemy-test-fifo-queue.fifo`;
      console.log("QUEUE NAME:", queueName);
      console.log("BRANCH_PREFIX:", BRANCH_PREFIX);

      const queue = new Queue(queueName, {
        queueName,
        fifo: true,
        visibilityTimeout: 30,
        contentBasedDeduplication: true,
        tags: {
          Environment: "test",
        },
      });

      try {
        const output = await apply(queue);
        expect(output.id).toBe(queueName);
        expect(output.url).toMatch(
          new RegExp(
            `https:\\/\\/sqs\\.[a-z0-9-]+\\.amazonaws\\.com\\/\\d+\\/${queueName.replace(/\./g, "\\.")}$`,
          ),
        );
        expect(output.fifo).toBe(true);
        expect(output.contentBasedDeduplication).toBe(true);

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
        await destroy(queue);
      }
    });

    test("create queue, send message, delete, and recreate", async () => {
      // Create initial queue
      const queueName = `${BRANCH_PREFIX}-alchemy-test-queue-recreate`;
      const queue = new Queue(queueName, {
        queueName,
        fifo: false,
        visibilityTimeout: 30,
      });

      try {
        const output = await apply(queue);
        expect(output.id).toBe(queueName);
        expect(output.arn).toMatch(
          new RegExp(`^arn:aws:sqs:[a-z0-9-]+:\\d+:${queueName}$`),
        );
        expect(output.url).toMatch(
          new RegExp(
            `^https:\\/\\/sqs\\.[a-z0-9-]+\\.amazonaws\\.com\\/\\d+\\/${queueName}$`,
          ),
        );

        // Send a test message
        const messageResponse = await sqs.send(
          new SendMessageCommand({
            QueueUrl: output.url,
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
        const recreatedQueue = new Queue(queueName, {
          queueName,
          visibilityTimeout: 30,
          messageRetentionPeriod: 345600,
          tags: {
            Environment: "test",
          },
        });

        try {
          const recreatedOutput = await apply(recreatedQueue);
          expect(recreatedOutput.id).toBe(queueName);
          expect(recreatedOutput.arn).toMatch(
            new RegExp(`^arn:aws:sqs:[a-z0-9-]+:\\d+:${queueName}$`),
          );
          expect(recreatedOutput.url).toMatch(
            new RegExp(
              `^https:\\/\\/sqs\\.[a-z0-9-]+\\.amazonaws\\.com\\/\\d+\\/${queueName}$`,
            ),
          );
        } finally {
          // Always clean up, even if test assertions fail
          await destroy(recreatedQueue);
        }
      } catch (error) {
        // In case the initial queue creation or tests fail
        await destroy(queue).catch(() => {}); // Ignore errors on cleanup
        throw error; // Re-throw the original error
      }
    });
  });
});
