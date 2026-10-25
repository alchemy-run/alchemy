import type * as queues from "@distilled.cloud/azure/storage-queue";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Queue } from "./Queue.ts";

/** The `MessagesDequeue` request without the `url` and `queueName` the bound queue supplies. */
export interface ReceiveQueueMessagesRequest extends Omit<
  queues.MessagesDequeueRequest,
  "url" | "queueName"
> {}

/**
 * Dequeue up to 32 messages of an Azure Storage queue (Get Messages) on any host. Received messages stay hidden for `visibilitytimeout` seconds; delete them with {@link DeleteQueueMessage}.
 *
 * Binding assigns a custom role with only `messages/process/action` (every built-in queue role also grants `messages/read`)
 * on the queue only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link ReceiveQueueMessagesHttp}.
 *
 * ### Receiving Messages
 * **Example:** Dequeue a batch
 * ```typescript
 * export default class Worker extends Azure.Functions.Function<Worker>()(
 *   "Worker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const queue = yield* Jobs;
 *     // init: assigns the role on the queue
 *     const receiveMessages = yield* Azure.Storage.ReceiveQueueMessages(queue);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const messages = yield* receiveMessages({ numofmessages: 16, visibilitytimeout: 60 });
 *         return yield* HttpServerResponse.json(messages.map((m) => m.MessageText));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.ReceiveQueueMessagesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface ReceiveQueueMessages extends Binding.Service<
  ReceiveQueueMessages,
  "Azure.Storage.ReceiveQueueMessages",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request?: ReceiveQueueMessagesRequest,
    ) => Effect.Effect<queues.MessagesDequeueResponse, queues.MessagesDequeueError, RuntimeContext>
  >
> {}

export const ReceiveQueueMessages = Binding.Service<ReceiveQueueMessages>(
  "Azure.Storage.ReceiveQueueMessages",
);
