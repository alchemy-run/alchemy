import * as queues from "@distilled.cloud/cloudflare/queues";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { Account } from "../Account.ts";
import type { Providers } from "../Providers.ts";

export type QueueConsumerProps = {
  /**
   * The queue ID to attach the consumer to.
   */
  queueId: string;
  /**
   * Name of the Worker script that will consume messages.
   */
  scriptName: string;
  /**
   * Optional dead letter queue name for failed messages.
   */
  deadLetterQueue?: string;
  /**
   * Consumer settings.
   */
  settings?: {
    /**
     * The maximum number of messages per batch.
     * @default 10
     */
    batchSize?: number;
    /**
     * The maximum number of concurrent consumer invocations.
     */
    maxConcurrency?: number;
    /**
     * The maximum number of retries for a message.
     * @default 3
     */
    maxRetries?: number;
    /**
     * The maximum time to wait for a batch to fill, in milliseconds.
     * @default 5000
     */
    maxWaitTimeMs?: number;
    /**
     * The number of seconds to wait before retrying a message.
     */
    retryDelay?: number;
  };
};

export type QueueConsumer = Resource<
  "Cloudflare.QueueConsumer",
  QueueConsumerProps,
  {
    consumerId: string;
    queueId: string;
    scriptName: string;
    accountId: string;
  },
  never,
  Providers
>;

/**
 * A Cloudflare Queue Consumer that processes messages from a Queue.
 *
 * Register a Worker as a consumer of a Queue. The Worker's `queue()`
 * handler will be invoked with batches of messages.
 *
 * @section Registering a Consumer
 * @example Basic consumer
 * ```typescript
 * const queue = yield* Cloudflare.Queue("MyQueue");
 * const worker = yield* Cloudflare.Worker("Worker", { ... });
 *
 * yield* Cloudflare.QueueConsumer("MyConsumer", {
 *   queueId: queue.queueId,
 *   scriptName: "my-worker",
 * });
 * ```
 *
 * @example Consumer with settings
 * ```typescript
 * yield* Cloudflare.QueueConsumer("MyConsumer", {
 *   queueId: queue.queueId,
 *   scriptName: "my-worker",
 *   settings: {
 *     batchSize: 50,
 *     maxRetries: 5,
 *     maxWaitTimeMs: 10000,
 *   },
 * });
 * ```
 */
export const QueueConsumer = Resource<QueueConsumer>(
  "Cloudflare.QueueConsumer",
);

export const QueueConsumerProvider = () =>
  Provider.effect(
    QueueConsumer,
    Effect.gen(function* () {
      const accountId = yield* Account;
      const createConsumer = yield* queues.createConsumer;
      const getConsumer = yield* queues.getConsumer;
      const updateConsumer = yield* queues.updateConsumer;
      const deleteConsumer = yield* queues.deleteConsumer;
      const listConsumers = yield* queues.listConsumers;

      return {
        stables: ["consumerId", "accountId"],
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isResolved(news)) return undefined;
          if ((output?.accountId ?? accountId) !== accountId) {
            return { action: "replace" } as const;
          }
          // Queue change requires replacement
          if (output?.queueId && news.queueId !== output.queueId) {
            return { action: "replace" } as const;
          }
          // Script change requires replacement
          if (output?.scriptName && news.scriptName !== output.scriptName) {
            return { action: "replace" } as const;
          }
          // Settings change is an update
          if (
            JSON.stringify(olds.settings ?? {}) !==
            JSON.stringify(news.settings ?? {})
          ) {
            return { action: "update" } as const;
          }
        }),
        create: Effect.fn(function* ({ news }) {
          const consumer = yield* createConsumer({
            accountId,
            queueId: news.queueId!,
            scriptName: news.scriptName,
            type: "worker",
            deadLetterQueue: news.deadLetterQueue,
            settings: news.settings,
          }).pipe(
            Effect.catch(() =>
              Effect.gen(function* () {
                // Consumer may already exist -- look it up
                const existing = yield* listConsumers({
                  accountId,
                  queueId: news.queueId!,
                });
                const match = existing.result.find(
                  (c) => "script" in c && c.script === news.scriptName,
                );
                if (match && match.consumerId) {
                  return match as {
                    consumerId: string;
                    queueId?: string | null;
                  };
                }
                return yield* Effect.die(
                  `Consumer for script "${news.scriptName}" on queue "${news.queueId}" already exists but could not be found`,
                );
              }),
            ),
          );
          return {
            consumerId: consumer.consumerId!,
            queueId: news.queueId!,
            scriptName: news.scriptName!,
            accountId,
          };
        }),
        update: Effect.fn(function* ({ news, output }) {
          yield* updateConsumer({
            accountId: output.accountId,
            queueId: output.queueId,
            consumerId: output.consumerId,
            scriptName: news.scriptName,
            type: "worker",
            settings: news.settings,
            deadLetterQueue: news.deadLetterQueue,
          });
          return {
            consumerId: output.consumerId,
            queueId: output.queueId,
            scriptName: news.scriptName ?? output.scriptName,
            accountId: output.accountId,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* deleteConsumer({
            accountId: output.accountId,
            queueId: output.queueId,
            consumerId: output.consumerId,
          }).pipe(Effect.catch(() => Effect.void));
        }),
        read: Effect.fn(function* ({ output }) {
          if (output?.consumerId) {
            return yield* getConsumer({
              accountId: output.accountId,
              queueId: output.queueId,
              consumerId: output.consumerId,
            }).pipe(
              Effect.map((consumer) => ({
                consumerId: consumer.consumerId!,
                queueId: output.queueId,
                scriptName:
                  ("script" in consumer
                    ? (consumer.script as string)
                    : output.scriptName) ?? output.scriptName,
                accountId: output.accountId,
              })),
              Effect.catch(() => Effect.succeed(undefined)),
            );
          }
          return undefined;
        }),
      };
    }),
  );
