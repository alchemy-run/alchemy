import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type {
  AzureDataPlaneError,
  AzureManagedIdentityError,
} from "../Binding.ts";
import type { Queue } from "./Queue.ts";

export interface StorageQueueReceiveOptions {
  /** Messages to dequeue, 1-32. @default 1 */
  maxMessages?: number;
  /** Seconds the messages stay hidden from other receivers. @default 30 */
  visibilityTimeoutSeconds?: number;
}

/** A dequeued storage queue message. */
export interface StorageQueueMessage {
  messageId: string;
  /** Pass to `delete` to remove the message. */
  popReceipt: string;
  text: string;
  dequeueCount: number;
  insertionTime: string | undefined;
}

/** Receive + delete client for one storage queue. */
export interface ReceiveStorageQueueClient {
  /** Dequeue up to `maxMessages` messages (possibly none). */
  receive(
    options?: StorageQueueReceiveOptions,
  ): Effect.Effect<
    StorageQueueMessage[],
    AzureDataPlaneError | AzureManagedIdentityError,
    RuntimeContext
  >;
  /** Delete a received message; succeeds when it is already gone. */
  delete(
    message: Pick<StorageQueueMessage, "messageId" | "popReceipt">,
  ): Effect.Effect<
    void,
    AzureDataPlaneError | AzureManagedIdentityError,
    RuntimeContext
  >;
}

/**
 * Receive and delete messages from an Azure Storage queue in a Container
 * App or Function App.
 *
 * Binding grants the host's system-assigned managed identity
 * **Storage Queue Data Message Processor** on the queue only. Provide
 * {@link QueueReceiveHttp}.
 *
 * ### Processing Messages
 * **Example:** Drain a batch
 * ```typescript
 * // init
 * const jobs = yield* Azure.Storage.QueueReceive(queue);
 *
 * // runtime
 * const messages = yield* jobs.receive({ maxMessages: 16 });
 * for (const message of messages) {
 *   yield* handle(JSON.parse(message.text));
 *   yield* jobs.delete(message);
 * }
 * ```
 *
 * @binding
 * @category Storage
 */
export interface QueueReceive extends Binding.Service<
  QueueReceive,
  "Azure.Storage.QueueReceive",
  (queue: Queue) => Effect.Effect<ReceiveStorageQueueClient>
> {}

export const QueueReceive = Binding.Service<QueueReceive>(
  "Azure.Storage.QueueReceive",
);
