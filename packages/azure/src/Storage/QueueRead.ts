import type { AzureOpError } from "@distilled.cloud/azure";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Queue } from "./Queue.ts";
import type { PeekStorageQueueClient } from "./QueueReceive.ts";

/** What {@link ReadStorageQueueClient.getProperties} returns. */
export interface StorageQueueProperties {
  /** Approximate number of messages; never lower than the real count. */
  approximateMessageCount: number;
  /** User metadata, Alchemy's ownership markers included. */
  metadata: Record<string, string>;
}

/** Read-only client for one storage queue: nothing it does hides or removes a message. */
export interface ReadStorageQueueClient extends PeekStorageQueueClient {
  /** Read the queue's approximate message count and metadata. */
  getProperties(): Effect.Effect<StorageQueueProperties, AzureOpError, RuntimeContext>;
}

/**
 * Peek at the messages and read the depth of an Azure Storage queue on any
 * host, without hiding or removing anything.
 *
 * Binding assigns **Storage Queue Data Reader** (`messages/read` data
 * action, `queues/read` action) on the queue only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link QueueReadHttp}.
 *
 * ### Monitoring a Queue
 * **Example:** Report the backlog and the next message
 * ```typescript
 * export default class Monitor extends Azure.Functions.Function<Monitor>()(
 *   "Monitor",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const queue = yield* Jobs;
 *     const jobs = yield* Azure.Storage.QueueRead(queue);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { approximateMessageCount } = yield* jobs.getProperties();
 *         const [next] = yield* jobs.peek();
 *         return yield* HttpServerResponse.json({ approximateMessageCount, next: next?.text });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.QueueReadHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface QueueRead extends Binding.Service<
  QueueRead,
  "Azure.Storage.QueueRead",
  (queue: Queue) => Effect.Effect<ReadStorageQueueClient>
> {}

export const QueueRead = Binding.Service<QueueRead>("Azure.Storage.QueueRead");
