import type * as messaging from "@distilled.cloud/azure/servicebus-messaging";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Queue } from "./Queue.ts";
import type { Topic } from "./Topic.ts";

/** The `SendMessageBatch` request without the `namespaceName` and `entityPath` the bound queue or topic supplies. */
export interface SendMessageBatchRequest extends Omit<
  messaging.SendMessageBatchRequest,
  "namespaceName" | "entityPath"
> {}

/**
 * Send several messages to an Azure Service Bus queue or topic in one request
 * (Send Message Batch) from any host. Custom properties go on each message as
 * `userProperties`.
 *
 * Binding assigns **Azure Service Bus Data Sender**
 * (the `send/action` data action) on the queue or topic only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link SendMessageBatchHttp}.
 *
 * ### Sending Messages
 * **Example:** Send a batch
 * ```typescript
 * export default class Worker extends Azure.Functions.Function<Worker>()(
 *   "Worker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const queue = yield* Orders;
 *     // init: assigns the role on the queue or topic only
 *     const sendBatch = yield* Azure.ServiceBus.SendMessageBatch(queue);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* sendBatch({
 *           messages: [
 *             { body: "first", brokerProperties: { label: "a" } },
 *             { body: "second", userProperties: { priority: "low" } },
 *           ],
 *         });
 *         return yield* HttpServerResponse.json({ sent: 2 });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.ServiceBus.SendMessageBatchHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category ServiceBus
 */
export interface SendMessageBatch extends Binding.Service<
  SendMessageBatch,
  "Azure.ServiceBus.SendMessageBatch",
  (
    entity: Queue | Topic,
  ) => Effect.Effect<
    (
      request: SendMessageBatchRequest,
    ) => Effect.Effect<
      messaging.SendMessageBatchResponse,
      messaging.SendMessageBatchError,
      RuntimeContext
    >
  >
> {}

export const SendMessageBatch = Binding.Service<SendMessageBatch>(
  "Azure.ServiceBus.SendMessageBatch",
);
