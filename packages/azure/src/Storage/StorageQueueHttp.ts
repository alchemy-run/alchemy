import * as queues from "@distilled.cloud/azure/storage-queue";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as AzureBindings from "../AzureBindings.ts";
import type { Queue } from "./Queue.ts";
import type {
  ReceiveStorageQueueClient,
  StorageQueueMessage,
  StorageQueueReceiveOptions,
} from "./QueueReceive.ts";
import type { SendStorageQueueClient, StorageQueueSendOptions } from "./QueueSend.ts";

/**
 * Shared scaffolding for the storage queue bindings: resolves the distilled
 * `storage-queue` operations once when the layer is built and assigns
 * `role` on the bound queue at deploy time.
 *
 * NOT exported from `index.ts`.
 */

/** Where a queue lives, resolved per call at runtime. */
interface QueueAddress {
  readonly tag: string;
  /** `https://{account}.queue.core.windows.net` */
  readonly url: Effect.Effect<string>;
  readonly queueName: Effect.Effect<string>;
}

const GrantOnQueue = Effect.gen(function* () {
  const bind = yield* AzureBindings.Bind;
  return Effect.fn(function* (tag: string, queue: Queue, role: string) {
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      yield* bind`${tag}(${queue})`({
        roleAssignments: [{ roleDefinitionId: role, scope: queue.queueId }],
      });
    }
  });
});

const at = (address: QueueAddress) =>
  Effect.all({ url: address.url, queueName: address.queueName });

export const makeSendStorageQueueClient = Effect.gen(function* () {
  const enqueue = yield* AzureBindings.withCredentials(queues.MessagesEnqueue);
  return (address: QueueAddress): SendStorageQueueClient => ({
    send: Effect.fn(`${address.tag}.send`)(function* (
      message: string,
      options?: StorageQueueSendOptions,
    ) {
      const where = yield* at(address);
      const [sent] = yield* enqueue({
        ...where,
        MessageText: message,
        visibilitytimeout: options?.visibilityTimeoutSeconds,
        messagettl: options?.timeToLiveSeconds,
      });
      return {
        messageId: sent?.MessageId,
        popReceipt: sent?.PopReceipt,
        insertionTime: sent?.InsertionTime,
      };
    }),
  });
});

export const makeReceiveStorageQueueClient = Effect.gen(function* () {
  const dequeue = yield* AzureBindings.withCredentials(queues.MessagesDequeue);
  const deleteMessage = yield* AzureBindings.withCredentials(queues.DeleteMessageId);
  return (address: QueueAddress): ReceiveStorageQueueClient => ({
    receive: Effect.fn(`${address.tag}.receive`)(function* (options?: StorageQueueReceiveOptions) {
      const where = yield* at(address);
      const messages = yield* dequeue({
        ...where,
        numofmessages: options?.maxMessages ?? 1,
        visibilitytimeout: options?.visibilityTimeoutSeconds,
      });
      return messages.map((message): StorageQueueMessage => ({
        messageId: message.MessageId,
        popReceipt: message.PopReceipt,
        text: message.MessageText,
        dequeueCount: message.DequeueCount,
        insertionTime: message.InsertionTime,
      }));
    }),
    delete: Effect.fn(`${address.tag}.delete`)(function* (
      message: Pick<StorageQueueMessage, "messageId" | "popReceipt">,
    ) {
      const where = yield* at(address);
      yield* deleteMessage({
        ...where,
        messageid: message.messageId,
        popreceipt: message.popReceipt,
      }).pipe(Effect.catchTag("MessageNotFound", () => Effect.void));
    }),
  });
});

/**
 * Build a storage queue binding that assigns `role` on the queue and
 * returns the client `makeClient` builds.
 */
export const makeStorageQueueBinding = <Client>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.Storage.QueueSend`. */
  tag: string;
  /** Built-in role GUID assigned on the queue. */
  role: string;
  makeClient: Effect.Effect<(address: QueueAddress) => Client>;
}) =>
  Effect.gen(function* () {
    const grantOnQueue = yield* GrantOnQueue;
    const makeClient = yield* options.makeClient;
    return Effect.fn(function* (queue: Queue) {
      yield* grantOnQueue(options.tag, queue, options.role);
      const url = yield* Output.interpolate`https://${queue.storageAccount}.queue.core.windows.net`;
      const queueName = yield* queue.queueName;
      return makeClient({ tag: `${options.tag}(${queue.LogicalId})`, url, queueName });
    });
  });
