import * as queues from "@distilled.cloud/cloudflare/queues";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { Account } from "../Account.ts";
import type { Providers } from "../Providers.ts";
import { QueueBinding } from "./QueueBinding.ts";

export type QueueProps = {
  /**
   * Name of the queue. If omitted, a unique name will be generated.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
};

export type Queue = Resource<
  "Cloudflare.Queue",
  QueueProps,
  {
    queueId: string;
    queueName: string;
    accountId: string;
  },
  never,
  Providers
>;

/**
 * A Cloudflare Queue for reliable message passing between Workers.
 *
 * Queues enable you to send and receive messages with guaranteed delivery.
 * Create a queue as a resource, then bind it to a Worker to send messages
 * at runtime. Register a consumer to process messages.
 *
 * @section Creating a Queue
 * @example Basic queue
 * ```typescript
 * const queue = yield* Cloudflare.Queue("MyQueue");
 * ```
 *
 * @example Queue with explicit name
 * ```typescript
 * const queue = yield* Cloudflare.Queue("MyQueue", {
 *   name: "my-app-queue",
 * });
 * ```
 *
 * @section Binding to a Worker
 * @example Sending messages from a Worker
 * ```typescript
 * // In your Worker definition, add the queue to bindings:
 * const Worker = Cloudflare.Worker("Worker", {
 *   bindings: { MY_QUEUE: queue },
 * });
 * ```
 */
export const Queue = Resource<Queue>("Cloudflare.Queue")({
  bind: QueueBinding.bind,
});

export const QueueProvider = () =>
  Provider.effect(
    Queue,
    Effect.gen(function* () {
      const accountId = yield* Account;
      const createQueue = yield* queues.createQueue;
      const getQueue = yield* queues.getQueue;
      const updateQueue = yield* queues.updateQueue;
      const deleteQueue = yield* queues.deleteQueue;
      const listQueues = yield* queues.listQueues;

      const createQueueName = (id: string, name: string | undefined) =>
        Effect.gen(function* () {
          if (name) return name;
          return (yield* createPhysicalName({
            id,
            maxLength: 63,
          })).toLowerCase();
        });

      return {
        stables: ["queueId", "accountId"],
        diff: Effect.fn(function* ({ id, olds = {}, news = {}, output }) {
          if (!isResolved(news)) return undefined;
          if ((output?.accountId ?? accountId) !== accountId) {
            return { action: "replace" } as const;
          }
          const name = yield* createQueueName(id, news.name);
          const oldName = output?.queueName
            ? output.queueName
            : yield* createQueueName(id, olds.name);
          if (name !== oldName) {
            return { action: "replace" } as const;
          }
        }),
        create: Effect.fn(function* ({ id, news = {} }) {
          const queueName = yield* createQueueName(id, news.name);
          const queue = yield* createQueue({
            accountId,
            queueName,
          }).pipe(
            Effect.catch(() =>
              Effect.gen(function* () {
                // Queue may already exist -- look it up by name
                const allQueues = yield* listQueues({ accountId });
                const match = allQueues.result.find(
                  (q) => q.queueName === queueName,
                );
                if (match && match.queueId && match.queueName) {
                  return match as { queueId: string; queueName: string };
                }
                return yield* Effect.die(
                  `Queue "${queueName}" already exists but could not be found`,
                );
              }),
            ),
          );
          return {
            queueId: queue.queueId!,
            queueName: queue.queueName!,
            accountId,
          };
        }),
        update: Effect.fn(function* ({ id, news = {}, output }) {
          const queueName = yield* createQueueName(id, news.name);
          const queue = yield* updateQueue({
            accountId: output.accountId,
            queueId: output.queueId,
            queueName,
          });
          return {
            queueId: queue.queueId!,
            queueName: queue.queueName!,
            accountId: output.accountId,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* deleteQueue({
            accountId: output.accountId,
            queueId: output.queueId,
          }).pipe(Effect.catch(() => Effect.void));
        }),
        read: Effect.fn(function* ({ id, output, olds }) {
          if (output?.queueId) {
            return yield* getQueue({
              accountId: output.accountId,
              queueId: output.queueId,
            }).pipe(
              Effect.map((queue) => ({
                queueId: queue.queueId!,
                queueName: queue.queueName!,
                accountId: output.accountId,
              })),
              Effect.catch(() => Effect.succeed(undefined)),
            );
          }
          const queueName = yield* createQueueName(id, olds?.name);
          const allQueues = yield* listQueues({ accountId });
          const match = allQueues.result.find((q) => q.queueName === queueName);
          if (match && match.queueId && match.queueName) {
            return {
              queueId: match.queueId,
              queueName: match.queueName,
              accountId,
            };
          }
          return undefined;
        }),
      };
    }),
  );
