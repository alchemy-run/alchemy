import type * as queues from "@distilled.cloud/azure/storage-queue";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Queue } from "./Queue.ts";

/** The `DeleteMessageId` request without the `url` and `queueName` the bound queue supplies. */
export interface DeleteQueueMessageRequest extends Omit<
  queues.DeleteMessageIdRequest,
  "url" | "queueName"
> {}

/**
 * Delete one received message of an Azure Storage queue (Delete Message) on any host, by its message ID and pop receipt.
 *
 * Binding assigns a custom role with only `messages/process/action` (the same role {@link ReceiveQueueMessages} uses)
 * on the queue only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link DeleteQueueMessageHttp}.
 *
 * ### Deleting Messages
 * **Example:** Delete a message after handling it
 * ```typescript
 * export default class Worker extends Azure.Functions.Function<Worker>()(
 *   "Worker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const queue = yield* Jobs;
 *     // init: assigns the role on the queue
 *     const receiveMessages = yield* Azure.Storage.ReceiveQueueMessages(queue);
 *     const deleteMessage = yield* Azure.Storage.DeleteQueueMessage(queue);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const [message] = yield* receiveMessages();
 *         if (message !== undefined) {
 *           yield* deleteMessage({ messageid: message.MessageId, popreceipt: message.PopReceipt });
 *         }
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Layer.mergeAll(Azure.Storage.ReceiveQueueMessagesHttp, Azure.Storage.DeleteQueueMessageHttp))),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface DeleteQueueMessage extends Binding.Service<
  DeleteQueueMessage,
  "Azure.Storage.DeleteQueueMessage",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request: DeleteQueueMessageRequest,
    ) => Effect.Effect<queues.DeleteMessageIdResponse, queues.DeleteMessageIdError, RuntimeContext>
  >
> {}

export const DeleteQueueMessage = Binding.Service<DeleteQueueMessage>(
  "Azure.Storage.DeleteQueueMessage",
);
