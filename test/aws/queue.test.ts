import {
  GetQueueUrlCommand,
  SQSClient,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import { describe, expect, test } from "bun:test";
import { apply } from "../../alchemy/src/apply";
import { Queue } from "../../alchemy/src/aws/queue";
import { destroy } from "../../alchemy/src/destroy";

const sqs = new SQSClient({});

describe("AWS Resources", () => {
  describe("Queue", () => {
    const queueName = "alchemy-test-queue";

    test("create queue, send message, delete, and recreate", async () => {
      // Create initial queue
      const queue = new Queue(queueName, {
        queueName,
        visibilityTimeout: 30,
        messageRetentionPeriod: 345600, // 4 days
        tags: {
          Environment: "test",
        },
      });

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

      // Clean up
      await destroy(recreatedQueue);
    });
  });
});
