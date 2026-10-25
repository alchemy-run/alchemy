import type { AzureOpError } from "@distilled.cloud/azure";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Queue } from "./Queue.ts";
import type { StorageQueueMessage } from "./QueueReceive.ts";
import type { SendStorageQueueClient } from "./QueueSend.ts";

/** Options for {@link WriteStorageQueueClient.update}. */
export interface StorageQueueUpdateOptions {
  /** New message text (max 64 KiB). */
  text: string;
  /** Seconds until the message is visible again. @default 0 */
  visibilityTimeoutSeconds?: number;
}

/** What {@link WriteStorageQueueClient.update} returns. */
export interface StorageQueueUpdateResult {
  /** The message's new pop receipt; the old one no longer works. */
  popReceipt: string;
  /** When the message is visible again. */
  timeNextVisible: string | undefined;
}

/** Write client for one storage queue. */
export interface WriteStorageQueueClient extends SendStorageQueueClient {
  /** Replace a received message's text and visibility timeout. */
  update(
    message: Pick<StorageQueueMessage, "messageId" | "popReceipt">,
    options: StorageQueueUpdateOptions,
  ): Effect.Effect<StorageQueueUpdateResult, AzureOpError, RuntimeContext>;
  /** Delete a received message; succeeds when it is already gone. */
  delete(
    message: Pick<StorageQueueMessage, "messageId" | "popReceipt">,
  ): Effect.Effect<void, AzureOpError, RuntimeContext>;
  /** Delete every message in the queue. */
  clear(): Effect.Effect<void, AzureOpError, RuntimeContext>;
}

/**
 * Send, update, delete, and clear the messages of an Azure Storage queue on
 * any host.
 *
 * Binding assigns a custom role with only `messages/write`,
 * `messages/delete`, and `messages/process/action` (Delete Message needs
 * it) on the queue only. Storage Queue Data Contributor also grants
 * reading messages and writing and deleting the queue itself.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link QueueWriteHttp}.
 *
 * ### Writing Messages
 * **Example:** Send a message, then clear the queue
 * ```typescript
 * export default class Producer extends Azure.Functions.Function<Producer>()(
 *   "Producer",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const queue = yield* Jobs;
 *     const jobs = yield* Azure.Storage.QueueWrite(queue);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const sent = yield* jobs.send("hello", { timeToLiveSeconds: 3600 });
 *         yield* jobs.clear();
 *         return yield* HttpServerResponse.json(sent);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.QueueWriteHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface QueueWrite extends Binding.Service<
  QueueWrite,
  "Azure.Storage.QueueWrite",
  (queue: Queue) => Effect.Effect<WriteStorageQueueClient>
> {}

export const QueueWrite = Binding.Service<QueueWrite>("Azure.Storage.QueueWrite");
