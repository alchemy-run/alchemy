import type * as queues from "@distilled.cloud/azure/storage-queue";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Queue } from "./Queue.ts";

/** The `UpdateMessageId` request without the `url` and `queueName` the bound queue supplies. */
export interface UpdateQueueMessageRequest extends Omit<
  queues.UpdateMessageIdRequest,
  "url" | "queueName"
> {}

/**
 * Change the text and visibility timeout of a received message of an Azure Storage queue (Update Message) on any host. The response carries the new pop receipt.
 *
 * Binding assigns a custom role with only `messages/write` (Storage Queue Data Contributor also grants queue writes and deletes)
 * on the queue only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link UpdateQueueMessageHttp}.
 *
 * ### Updating Messages
 * **Example:** Extend the lease of a message
 * ```typescript
 * export default class Worker extends Azure.Functions.Function<Worker>()(
 *   "Worker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const queue = yield* Jobs;
 *     // init: assigns the role on the queue
 *     const receiveMessages = yield* Azure.Storage.ReceiveQueueMessages(queue);
 *     const updateMessage = yield* Azure.Storage.UpdateQueueMessage(queue);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const [message] = yield* receiveMessages();
 *         if (message !== undefined) {
 *           yield* updateMessage({
 *             messageid: message.MessageId,
 *             popreceipt: message.PopReceipt,
 *             MessageText: message.MessageText,
 *             visibilitytimeout: 300,
 *           });
 *         }
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Layer.mergeAll(Azure.Storage.ReceiveQueueMessagesHttp, Azure.Storage.UpdateQueueMessageHttp))),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface UpdateQueueMessage extends Binding.Service<
  UpdateQueueMessage,
  "Azure.Storage.UpdateQueueMessage",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request: UpdateQueueMessageRequest,
    ) => Effect.Effect<queues.UpdateMessageIdResponse, queues.UpdateMessageIdError, RuntimeContext>
  >
> {}

export const UpdateQueueMessage = Binding.Service<UpdateQueueMessage>(
  "Azure.Storage.UpdateQueueMessage",
);
