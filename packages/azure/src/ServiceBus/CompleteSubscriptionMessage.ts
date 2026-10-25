import type * as messaging from "@distilled.cloud/azure/servicebus-messaging";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Subscription } from "./Subscription.ts";

/** The `CompleteSubscriptionMessage` request without the `namespaceName`, `topicName` and `subscriptionName` the bound subscription supplies. */
export interface CompleteSubscriptionMessageRequest extends Omit<
  messaging.CompleteSubscriptionMessageRequest,
  "namespaceName" | "topicName" | "subscriptionName"
> {}

/**
 * Complete a peek-locked message of an Azure Service Bus topic subscription
 * (Delete Message) on any host. Fails `MessageLockLost` when the lock expired
 * or the message was already settled.
 *
 * Binding assigns **Azure Service Bus Data Receiver**
 * (the `receive/action` data action) on the subscription only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link CompleteSubscriptionMessageHttp}.
 *
 * ### Settling Messages
 * **Example:** Complete a locked message
 * ```typescript
 * export default class Worker extends Azure.Functions.Function<Worker>()(
 *   "Worker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const subscription = yield* Audit;
 *     // init: assigns the role on the subscription only
 *     const completeMessage = yield* Azure.ServiceBus.CompleteSubscriptionMessage(subscription);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // messageId and lockToken: the lock URI (`location`) of a peek-locked message
 *         yield* completeMessage({ messageId, lockToken });
 *         return yield* HttpServerResponse.json({ completed: true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.ServiceBus.CompleteSubscriptionMessageHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category ServiceBus
 */
export interface CompleteSubscriptionMessage extends Binding.Service<
  CompleteSubscriptionMessage,
  "Azure.ServiceBus.CompleteSubscriptionMessage",
  (
    subscription: Subscription,
  ) => Effect.Effect<
    (
      request: CompleteSubscriptionMessageRequest,
    ) => Effect.Effect<
      messaging.CompleteSubscriptionMessageResponse,
      messaging.CompleteSubscriptionMessageError,
      RuntimeContext
    >
  >
> {}

export const CompleteSubscriptionMessage = Binding.Service<CompleteSubscriptionMessage>(
  "Azure.ServiceBus.CompleteSubscriptionMessage",
);
