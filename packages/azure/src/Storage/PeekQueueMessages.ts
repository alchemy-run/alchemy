import type * as queues from "@distilled.cloud/azure/storage-queue";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Queue } from "./Queue.ts";

/** The `MessagesPeek` request without the `url` and `queueName` the bound queue supplies. */
export interface PeekQueueMessagesRequest extends Omit<
  queues.MessagesPeekRequest,
  "url" | "queueName"
> {}

/**
 * Read up to 32 visible messages of an Azure Storage queue without hiding them (Peek Messages) on any host.
 *
 * Binding assigns **Storage Queue Data Reader** (`messages/read` data action, plus the `queues/read` action)
 * on the queue only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link PeekQueueMessagesHttp}.
 *
 * ### Peeking Messages
 * **Example:** Look at the head of the queue
 * ```typescript
 * export default class Worker extends Azure.Functions.Function<Worker>()(
 *   "Worker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const queue = yield* Jobs;
 *     // init: assigns the role on the queue
 *     const peekMessages = yield* Azure.Storage.PeekQueueMessages(queue);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const messages = yield* peekMessages({ numofmessages: 5 });
 *         return yield* HttpServerResponse.json(messages.map((m) => m.MessageText));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.PeekQueueMessagesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface PeekQueueMessages extends Binding.Service<
  PeekQueueMessages,
  "Azure.Storage.PeekQueueMessages",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request?: PeekQueueMessagesRequest,
    ) => Effect.Effect<queues.MessagesPeekResponse, queues.MessagesPeekError, RuntimeContext>
  >
> {}

export const PeekQueueMessages = Binding.Service<PeekQueueMessages>(
  "Azure.Storage.PeekQueueMessages",
);
