import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import { createPhysicalName } from "../../physical-name.ts";
import { Account } from "../account.ts";
import { Queue, type QueueProps } from "./queue.ts";
import { Region } from "distilled-aws/Region";
import * as sqs from "distilled-aws/sqs";

export const queueProvider = () =>
  Queue.provider.effect(
    Effect.gen(function* () {
      const region = yield* Region;
      const accountId = yield* Account;
      const createQueueName = (
        id: string,
        props: {
          queueName?: string | undefined;
          fifo?: boolean;
        },
      ) =>
        Effect.gen(function* () {
          if (props.queueName) {
            return props.queueName;
          }
          const baseName = yield* createPhysicalName({
            id,
            maxLength: props.fifo ? 80 - ".fifo".length : 80,
          });
          return props.fifo ? `${baseName}.fifo` : baseName;
        });
      const createAttributes = (props: QueueProps) => {
        const baseAttributes: Record<string, string | undefined> = {
          DelaySeconds: props.delaySeconds?.toString(),
          MaximumMessageSize: props.maximumMessageSize?.toString(),
          MessageRetentionPeriod: props.messageRetentionPeriod?.toString(),
          ReceiveMessageWaitTimeSeconds:
            props.receiveMessageWaitTimeSeconds?.toString(),
          VisibilityTimeout: props.visibilityTimeout?.toString(),
        };

        if (props.fifo) {
          return {
            ...baseAttributes,
            FifoQueue: "true",
            FifoThroughputLimit: props.fifoThroughputLimit,
            ContentBasedDeduplication: props.contentBasedDeduplication
              ? "true"
              : "false",
            DeduplicationScope: props.deduplicationScope,
          };
        }

        return baseAttributes;
      };
      return {
        stables: ["queueName", "queueUrl", "queueArn"],
        diff: Effect.fn(function* ({ id, news, olds }) {
          const oldFifo = olds.fifo ?? false;
          const newFifo = news.fifo ?? false;
          if (oldFifo !== newFifo) {
            return { action: "replace" } as const;
          }
          const oldQueueName = yield* createQueueName(id, olds);
          const newQueueName = yield* createQueueName(id, news);
          if (oldQueueName !== newQueueName) {
            return { action: "replace" } as const;
          }
          // Return undefined to allow update function to be called for other attribute changes
        }),
        create: Effect.fn(function* ({ id, news, session }) {
          const queueName = yield* createQueueName(id, news);
          const response = yield* sqs
            .createQueue({
              QueueName: queueName,
              Attributes: createAttributes(news),
            })
            .pipe(
              Effect.retry({
                while: (e) => e.name === "QueueDeletedRecently",
                schedule: Schedule.fixed(1000).pipe(
                  Schedule.tapOutput((i) =>
                    session.note(
                      `Queue was deleted recently, retrying... ${i + 1}s`,
                    ),
                  ),
                ),
              }),
            );
          const queueArn =
            `arn:aws:sqs:${region}:${accountId}:${queueName}` as const;
          const queueUrl = response.QueueUrl!;
          yield* session.note(queueUrl);
          return {
            queueName,
            queueUrl,
            queueArn: queueArn,
          };
        }),
        update: Effect.fn(function* ({ news, output, session }) {
          yield* sqs.setQueueAttributes({
            QueueUrl: output.queueUrl,
            Attributes: createAttributes(news),
          });
          yield* session.note(output.queueUrl);
          return output;
        }),
        delete: Effect.fn(function* (input) {
          yield* sqs
            .deleteQueue({
              QueueUrl: input.output.queueUrl,
            })
            .pipe(Effect.catchTag("QueueDoesNotExist", () => Effect.void));
        }),
      };
    }),
  );
