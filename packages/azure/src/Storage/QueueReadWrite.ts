import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Queue } from "./Queue.ts";
import type { ReadStorageQueueClient } from "./QueueRead.ts";
import type { ReceiveStorageQueueClient } from "./QueueReceive.ts";
import type { WriteStorageQueueClient } from "./QueueWrite.ts";

/** Full message client for one storage queue: read, receive, and write. */
export interface ReadWriteStorageQueueClient
  extends ReadStorageQueueClient, ReceiveStorageQueueClient, WriteStorageQueueClient {}

/**
 * Peek, receive, send, update, delete, and clear the messages of an Azure
 * Storage queue, and read its depth, on any host.
 *
 * Binding assigns a custom role on the queue only, with the `queues/read`
 * action and the `messages/read`, `messages/write`, `messages/delete`, and
 * `messages/process/action` data actions (Storage Queue Data Contributor
 * also grants writing and deleting the queue itself).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link QueueReadWriteHttp}.
 *
 * ### Processing a Queue
 * **Example:** Receive, retry later, or finish
 * ```typescript
 * export default class Processor extends Azure.Functions.Function<Processor>()(
 *   "Processor",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const queue = yield* Jobs;
 *     const jobs = yield* Azure.Storage.QueueReadWrite(queue);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const messages = yield* jobs.receive({ maxMessages: 16 });
 *         for (const message of messages) {
 *           if (message.dequeueCount > 3) yield* jobs.delete(message);
 *           else yield* jobs.update(message, { text: message.text, visibilityTimeoutSeconds: 60 });
 *         }
 *         const { approximateMessageCount } = yield* jobs.getProperties();
 *         return yield* HttpServerResponse.json({ approximateMessageCount });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.QueueReadWriteHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface QueueReadWrite extends Binding.Service<
  QueueReadWrite,
  "Azure.Storage.QueueReadWrite",
  (queue: Queue) => Effect.Effect<ReadWriteStorageQueueClient>
> {}

export const QueueReadWrite = Binding.Service<QueueReadWrite>("Azure.Storage.QueueReadWrite");
