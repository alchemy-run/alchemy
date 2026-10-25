import type * as messaging from "@distilled.cloud/azure/servicebus-messaging";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Queue } from "./Queue.ts";
import type { Topic } from "./Topic.ts";

/** The `SendMessage` request without the `namespaceName` and `entityPath` the bound queue or topic supplies. */
export interface SendMessageRequest extends Omit<
  messaging.SendMessageRequest,
  "namespaceName" | "entityPath"
> {}

/**
 * Send one message to an Azure Service Bus queue or topic (Send Message) from
 * any host. `brokerProperties` and `customProperties` travel as headers.
 *
 * Binding assigns **Azure Service Bus Data Sender**
 * (the `send/action` data action) on the queue or topic only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link SendMessageHttp}.
 *
 * ### Sending Messages
 * **Example:** Send a JSON message to a queue
 * ```typescript
 * export default class Worker extends Azure.Functions.Function<Worker>()(
 *   "Worker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const queue = yield* Orders;
 *     // init: assigns the role on the queue or topic only
 *     const sendMessage = yield* Azure.ServiceBus.SendMessage(queue);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* sendMessage({
 *           body: JSON.stringify({ orderId: "42" }),
 *           contentType: "application/json",
 *           brokerProperties: { messageId: "42", label: "order" },
 *           customProperties: { priority: "high" },
 *         });
 *         return yield* HttpServerResponse.json({ sent: true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.ServiceBus.SendMessageHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category ServiceBus
 */
export interface SendMessage extends Binding.Service<
  SendMessage,
  "Azure.ServiceBus.SendMessage",
  (
    entity: Queue | Topic,
  ) => Effect.Effect<
    (
      request: SendMessageRequest,
    ) => Effect.Effect<messaging.SendMessageResponse, messaging.SendMessageError, RuntimeContext>
  >
> {}

export const SendMessage = Binding.Service<SendMessage>("Azure.ServiceBus.SendMessage");
