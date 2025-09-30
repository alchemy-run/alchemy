import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import { App, type Provider } from "@alchemy.run/effect";
import { AccountID } from "../account.ts";
import { Region } from "../region.ts";
import { QueueClient } from "./queue.client.ts";
import { QueueType, type QueueAttributes, type QueueProps } from "./queue.ts";

export class QueueProvider extends Context.Tag(QueueType)<
  QueueProvider,
  Provider<QueueType, QueueProps, QueueAttributes<string, QueueProps>>
>() {}

export const queueProvider = () =>
  Layer.effect(
    QueueProvider,
    Effect.gen(function* () {
      const sqs = yield* QueueClient;
      const app = yield* App;
      const region = yield* Region;
      const accountId = yield* AccountID;
      const createQueueName = (id: string, props: QueueProps) =>
        props.queueName ??
        `${app.name}-${id}-${app.stage}${props.fifo ? ".fifo" : ""}`;
      const createAttributes = (props: QueueProps) => ({
        FifoQueue: props.fifo ? "true" : "false",
        FifoThroughputLimit: props.fifoThroughputLimit,
        ContentBasedDeduplication: props.contentBasedDeduplication
          ? "true"
          : "false",
        DeduplicationScope: props.deduplicationScope,
        DelaySeconds: props.delaySeconds?.toString(),
        MaximumMessageSize: props.maximumMessageSize?.toString(),
        MessageRetentionPeriod: props.messageRetentionPeriod?.toString(),
        ReceiveMessageWaitTimeSeconds:
          props.receiveMessageWaitTimeSeconds?.toString(),
        VisibilityTimeout: props.visibilityTimeout?.toString(),
      });
      return {
        type: QueueType,
        diff: Effect.fn(function* ({ id, news, olds }) {
          const oldFifo = olds.fifo ?? false;
          const newFifo = news.fifo ?? false;
          if (oldFifo !== newFifo) {
            return { action: "replace" };
          }
          const oldQueueName = createQueueName(id, olds);
          const newQueueName = createQueueName(id, news);
          if (oldQueueName !== newQueueName) {
            return { action: "replace" };
          }
          return { action: "noop" };
        }),
        create: Effect.fn(function* ({ id, news, session }) {
          const queueName = createQueueName(id, news);
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
          const queueArn = `arn:aws:sqs:${region}:${accountId}:${queueName}`;
          const queueUrl = response.QueueUrl!;
          yield* session.note(queueUrl);
          return {
            id,
            type: QueueType,
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
      } satisfies Provider<
        QueueType,
        QueueProps,
        QueueAttributes<string, QueueProps>
      >;
    }),
  );
