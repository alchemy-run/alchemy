import type * as queues from "@distilled.cloud/azure/storage-queue";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Queue } from "./Queue.ts";

/** The `MessagesEnqueue` request without the `url` and `queueName` the bound queue supplies. */
export interface SendQueueMessageRequest extends Omit<
  queues.MessagesEnqueueRequest,
  "url" | "queueName"
> {}

/**
 * Put one message on an Azure Storage queue (Put Message) from any host.
 *
 * Binding assigns **Storage Queue Data Message Sender** (`messages/add/action`)
 * on the queue only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link SendQueueMessageHttp}.
 *
 * ### Sending Messages
 * **Example:** Enqueue a message from a Function
 * ```typescript
 * export default class Worker extends Azure.Functions.Function<Worker>()(
 *   "Worker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const queue = yield* Jobs;
 *     // init: assigns the role on the queue
 *     const sendMessage = yield* Azure.Storage.SendQueueMessage(queue);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const [sent] = yield* sendMessage({
 *           MessageText: JSON.stringify({ jobId: "42" }),
 *           messagettl: 3600,
 *         });
 *         return yield* HttpServerResponse.json({ messageId: sent?.MessageId });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.SendQueueMessageHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface SendQueueMessage extends Binding.Service<
  SendQueueMessage,
  "Azure.Storage.SendQueueMessage",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request: SendQueueMessageRequest,
    ) => Effect.Effect<queues.MessagesEnqueueResponse, queues.MessagesEnqueueError, RuntimeContext>
  >
> {}

export const SendQueueMessage = Binding.Service<SendQueueMessage>("Azure.Storage.SendQueueMessage");
