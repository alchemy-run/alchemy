import type * as messaging from "@distilled.cloud/azure/servicebus-messaging";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Subscription } from "./Subscription.ts";

/** The `ReceiveAndDeleteSubscriptionMessage` request without the `namespaceName`, `topicName` and `subscriptionName` the bound subscription supplies. */
export interface ReceiveAndDeleteSubscriptionMessageRequest extends Omit<
  messaging.ReceiveAndDeleteSubscriptionMessageRequest,
  "namespaceName" | "topicName" | "subscriptionName"
> {}

/**
 * Receive the next message of an Azure Service Bus topic subscription and
 * remove it in one step (Receive and Delete Message) on any host. Without a
 * message within `timeout` seconds the response has no `body`.
 *
 * Binding assigns **Azure Service Bus Data Receiver**
 * (the `receive/action` data action) on the subscription only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link ReceiveAndDeleteSubscriptionMessageHttp}.
 *
 * ### Receiving Messages
 * **Example:** Receive and delete the next message
 * ```typescript
 * export default class Worker extends Azure.Functions.Function<Worker>()(
 *   "Worker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const subscription = yield* Audit;
 *     // init: assigns the role on the subscription only
 *     const receiveAndDelete = yield* Azure.ServiceBus.ReceiveAndDeleteSubscriptionMessage(subscription);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const message = yield* receiveAndDelete({ timeout: 5 });
 *         return yield* HttpServerResponse.json({ messageId: message.brokerProperties?.messageId });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.ServiceBus.ReceiveAndDeleteSubscriptionMessageHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category ServiceBus
 */
export interface ReceiveAndDeleteSubscriptionMessage extends Binding.Service<
  ReceiveAndDeleteSubscriptionMessage,
  "Azure.ServiceBus.ReceiveAndDeleteSubscriptionMessage",
  (
    subscription: Subscription,
  ) => Effect.Effect<
    (
      request?: ReceiveAndDeleteSubscriptionMessageRequest,
    ) => Effect.Effect<
      messaging.ReceiveAndDeleteSubscriptionMessageResponse,
      messaging.ReceiveAndDeleteSubscriptionMessageError,
      RuntimeContext
    >
  >
> {}

export const ReceiveAndDeleteSubscriptionMessage =
  Binding.Service<ReceiveAndDeleteSubscriptionMessage>(
    "Azure.ServiceBus.ReceiveAndDeleteSubscriptionMessage",
  );
