import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import type { Context } from "../context";
import { Resource } from "../resource";

export interface QueueProps {
  /**
   * Name of the queue
   * For FIFO queues, the name must end with the .fifo suffix
   */
  queueName: string;

  /**
   * Whether this is a FIFO queue.
   * If true, the queueName must end with .fifo suffix
   */
  fifo?: boolean;

  visibilityTimeout?: number;
  messageRetentionPeriod?: number;
  maximumMessageSize?: number;
  delaySeconds?: number;
  receiveMessageWaitTimeSeconds?: number;

  /**
   * Enables content-based deduplication for FIFO queues.
   * Only applicable when fifo is true.
   */
  contentBasedDeduplication?: boolean;

  deduplicationScope?: "messageGroup" | "queue";
  fifoThroughputLimit?: "perQueue" | "perMessageGroupId";
  tags?: Record<string, string>;
}

export interface Queue extends Resource<"sqs::Queue">, QueueProps {
  arn: string;
  url: string;
}

export const Queue = Resource(
  "sqs::Queue",
  async function (
    this: Context<Queue>,
    id: string,
    props: QueueProps,
  ): Promise<Queue> {
    const client = new SQSClient({});
    // Don't automatically add .fifo suffix - user must include it in queueName
    const queueName = props.queueName;

    // Validate that FIFO queues have .fifo suffix
    if (props.fifo && !queueName.endsWith(".fifo")) {
      throw new Error("FIFO queue names must end with .fifo suffix");
    }

    if (this.phase === "delete") {
      try {
        // Get queue URL first
        const urlResponse = await client.send(
          new GetQueueUrlCommand({
            QueueName: queueName,
          }),
        );

        // Delete the queue
        await client.send(
          new DeleteQueueCommand({
            QueueUrl: urlResponse.QueueUrl,
          }),
        );

        // Wait for queue to be deleted
        let queueDeleted = false;
        while (!queueDeleted) {
          try {
            await client.send(
              new GetQueueUrlCommand({
                QueueName: queueName,
              }),
            );
            // If we get here, queue still exists
            await new Promise((resolve) => setTimeout(resolve, 1000));
          } catch (error: any) {
            if (error.name === "QueueDoesNotExist") {
              queueDeleted = true;
            } else {
              throw error;
            }
          }
        }
      } catch (error: any) {
        if (error.name !== "QueueDoesNotExist") {
          throw error;
        }
      }

      return this.destroy();
    } else {
      // Create queue with attributes
      const attributes: Record<string, string> = {};

      if (props.visibilityTimeout !== undefined) {
        attributes["VisibilityTimeout"] = props.visibilityTimeout.toString();
      }
      if (props.messageRetentionPeriod !== undefined) {
        attributes["MessageRetentionPeriod"] =
          props.messageRetentionPeriod.toString();
      }
      if (props.maximumMessageSize !== undefined) {
        attributes["MaximumMessageSize"] = props.maximumMessageSize.toString();
      }
      if (props.delaySeconds !== undefined) {
        attributes["DelaySeconds"] = props.delaySeconds.toString();
      }
      if (props.receiveMessageWaitTimeSeconds !== undefined) {
        attributes["ReceiveMessageWaitTimeSeconds"] =
          props.receiveMessageWaitTimeSeconds.toString();
      }

      // FIFO specific attributes
      if (props.fifo) {
        attributes["FifoQueue"] = "true";
        if (props.contentBasedDeduplication) {
          attributes["ContentBasedDeduplication"] = "true";
        }
        if (props.deduplicationScope) {
          attributes["DeduplicationScope"] = props.deduplicationScope;
        }
        if (props.fifoThroughputLimit) {
          attributes["FifoThroughputLimit"] = props.fifoThroughputLimit;
        }
      }

      // Convert tags to AWS format
      const tags = props.tags
        ? Object.entries(props.tags).reduce(
            (acc, [key, value]) => ({ ...acc, [key]: value }),
            {},
          )
        : undefined;

      try {
        // Create the queue
        const createResponse = await client.send(
          new CreateQueueCommand({
            QueueName: queueName,
            Attributes: attributes,
            tags,
          }),
        );

        // Get queue attributes
        const attributesResponse = await client.send(
          new GetQueueAttributesCommand({
            QueueUrl: createResponse.QueueUrl,
            AttributeNames: ["QueueArn"],
          }),
        );

        return this({
          ...props,
          arn: attributesResponse.Attributes!.QueueArn!,
          url: createResponse.QueueUrl!,
        });
      } catch (error: any) {
        if (error.name === "QueueAlreadyExists") {
          // Get existing queue URL
          const urlResponse = await client.send(
            new GetQueueUrlCommand({
              QueueName: queueName,
            }),
          );

          // Get queue attributes
          const attributesResponse = await client.send(
            new GetQueueAttributesCommand({
              QueueUrl: urlResponse.QueueUrl,
              AttributeNames: ["QueueArn"],
            }),
          );

          return this({
            ...props,
            arn: attributesResponse.Attributes!.QueueArn!,
            url: urlResponse.QueueUrl!,
          });
        } else if (error.name === "QueueDeletedRecently") {
          // Queue was recently deleted, wait and retry
          const maxRetries = 3;
          let retryCount = 0;

          while (retryCount < maxRetries) {
            try {
              // Wait for 60 seconds before retrying
              await new Promise((resolve) => setTimeout(resolve, 61000));

              // Retry creating the queue
              const createResponse = await client.send(
                new CreateQueueCommand({
                  QueueName: queueName,
                  Attributes: attributes,
                  tags,
                }),
              );

              // Get queue attributes
              const attributesResponse = await client.send(
                new GetQueueAttributesCommand({
                  QueueUrl: createResponse.QueueUrl,
                  AttributeNames: ["QueueArn"],
                }),
              );

              return this({
                ...props,
                arn: attributesResponse.Attributes!.QueueArn!,
                url: createResponse.QueueUrl!,
              });
            } catch (retryError: any) {
              if (
                retryError.name !== "QueueDeletedRecently" ||
                retryCount === maxRetries - 1
              ) {
                throw retryError;
              }
              retryCount++;
            }
          }
        }
        throw error;
      }
    }
  },
);
