import type { AzureOpError } from "@distilled.cloud/azure";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
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

/** A storage queue message read with `peek` (no pop receipt: it stays visible). */
export interface StorageQueuePeekedMessage {
  messageId: string;
  text: string;
  dequeueCount: number;
  insertionTime: string | undefined;
}

/** Peek client for one storage queue. */
export interface PeekStorageQueueClient {
  /** Read up to `maxMessages` (1-32) visible messages without hiding them. @default 1 */
  peek(
    maxMessages?: number,
  ): Effect.Effect<StorageQueuePeekedMessage[], AzureOpError, RuntimeContext>;
}

/** Receive + delete + peek client for one storage queue. */
export interface ReceiveStorageQueueClient extends PeekStorageQueueClient {
  /** Dequeue up to `maxMessages` messages (possibly none). */
  receive(
    options?: StorageQueueReceiveOptions,
  ): Effect.Effect<StorageQueueMessage[], AzureOpError, RuntimeContext>;
  /** Delete a received message; succeeds when it is already gone. */
  delete(
    message: Pick<StorageQueueMessage, "messageId" | "popReceipt">,
  ): Effect.Effect<void, AzureOpError, RuntimeContext>;
}

/**
 * Receive, delete, and peek messages of an Azure Storage queue on any host.
 *
 * Binding assigns **Storage Queue Data Message Processor** (`messages/read`
 * and `messages/process/action`) on the queue only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link QueueReceiveHttp}.
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

export const QueueReceive = Binding.Service<QueueReceive>("Azure.Storage.QueueReceive");
