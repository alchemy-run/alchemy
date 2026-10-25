import type * as queues from "@distilled.cloud/azure/storage-queue";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Queue } from "./Queue.ts";

/** The `ClearMessage` request without the `url` and `queueName` the bound queue supplies. */
export interface ClearQueueMessagesRequest extends Omit<
  queues.ClearMessageRequest,
  "url" | "queueName"
> {}

/**
 * Delete every message of an Azure Storage queue (Clear Messages) on any host.
 *
 * Binding assigns a custom role with only `messages/delete`
 * on the queue only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link ClearQueueMessagesHttp}.
 *
 * ### Clearing a Queue
 * **Example:** Purge all messages
 * ```typescript
 * export default class Worker extends Azure.Functions.Function<Worker>()(
 *   "Worker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const queue = yield* Jobs;
 *     // init: assigns the role on the queue
 *     const clearMessages = yield* Azure.Storage.ClearQueueMessages(queue);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* clearMessages();
 *         return HttpServerResponse.text("cleared");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.ClearQueueMessagesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface ClearQueueMessages extends Binding.Service<
  ClearQueueMessages,
  "Azure.Storage.ClearQueueMessages",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request?: ClearQueueMessagesRequest,
    ) => Effect.Effect<queues.ClearMessageResponse, queues.ClearMessageError, RuntimeContext>
  >
> {}

export const ClearQueueMessages = Binding.Service<ClearQueueMessages>(
  "Azure.Storage.ClearQueueMessages",
);
