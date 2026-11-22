import type * as messaging from "@distilled.cloud/azure/servicebus-messaging";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Queue } from "./Queue.ts";

/** The `ReceiveAndDeleteMessage` request without the `namespaceName` and `queueName` the bound queue supplies. */
export interface ReceiveAndDeleteMessageRequest extends Omit<
  messaging.ReceiveAndDeleteMessageRequest,
  "namespaceName" | "queueName"
> {}

/**
 * Receive the next message of an Azure Service Bus queue and remove it in one
 * step (Receive and Delete Message) on any host: at-most-once delivery.
 * Without a message within `timeout` seconds the response has no `body`.
 *
 * Binding assigns **Azure Service Bus Data Receiver**
 * (the `receive/action` data action) on the queue only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link ReceiveAndDeleteMessageHttp}.
 *
 * ### Receiving Messages
 * **Example:** Receive and delete the next message
 * ```typescript
 * export default class Worker extends Azure.Functions.Function<Worker>()(
 *   "Worker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const queue = yield* Orders;
 *     // init: assigns the role on the queue only
 *     const receiveAndDelete = yield* Azure.ServiceBus.ReceiveAndDeleteMessage(queue);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const message = yield* receiveAndDelete({ timeout: 5 });
 *         return yield* HttpServerResponse.json({ messageId: message.brokerProperties?.messageId });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.ServiceBus.ReceiveAndDeleteMessageHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category ServiceBus
 */
export interface ReceiveAndDeleteMessage extends Binding.Service<
  ReceiveAndDeleteMessage,
  "Azure.ServiceBus.ReceiveAndDeleteMessage",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request?: ReceiveAndDeleteMessageRequest,
    ) => Effect.Effect<
      messaging.ReceiveAndDeleteMessageResponse,
      messaging.ReceiveAndDeleteMessageError,
      RuntimeContext
    >
  >
> {}

export const ReceiveAndDeleteMessage = Binding.Service<ReceiveAndDeleteMessage>(
  "Azure.ServiceBus.ReceiveAndDeleteMessage",
);
