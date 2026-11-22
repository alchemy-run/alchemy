import type * as messaging from "@distilled.cloud/azure/servicebus-messaging";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Subscription } from "./Subscription.ts";

/** The `UnlockSubscriptionMessage` request without the `namespaceName`, `topicName` and `subscriptionName` the bound subscription supplies. */
export interface UnlockSubscriptionMessageRequest extends Omit<
  messaging.UnlockSubscriptionMessageRequest,
  "namespaceName" | "topicName" | "subscriptionName"
> {}

/**
 * Release the lock on a peek-locked message of an Azure Service Bus topic
 * subscription (Unlock Message) on any host, so it is delivered again. Fails
 * `MessageLockLost` when the lock expired.
 *
 * Binding assigns **Azure Service Bus Data Receiver**
 * (the `receive/action` data action) on the subscription only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link UnlockSubscriptionMessageHttp}.
 *
 * ### Settling Messages
 * **Example:** Abandon a locked message
 * ```typescript
 * export default class Worker extends Azure.Functions.Function<Worker>()(
 *   "Worker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const subscription = yield* Audit;
 *     // init: assigns the role on the subscription only
 *     const unlockMessage = yield* Azure.ServiceBus.UnlockSubscriptionMessage(subscription);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // messageId and lockToken: the lock URI (`location`) of a peek-locked message
 *         yield* unlockMessage({ messageId, lockToken });
 *         return yield* HttpServerResponse.json({ unlocked: true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.ServiceBus.UnlockSubscriptionMessageHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category ServiceBus
 */
export interface UnlockSubscriptionMessage extends Binding.Service<
  UnlockSubscriptionMessage,
  "Azure.ServiceBus.UnlockSubscriptionMessage",
  (
    subscription: Subscription,
  ) => Effect.Effect<
    (
      request: UnlockSubscriptionMessageRequest,
    ) => Effect.Effect<
      messaging.UnlockSubscriptionMessageResponse,
      messaging.UnlockSubscriptionMessageError,
      RuntimeContext
    >
  >
> {}

export const UnlockSubscriptionMessage = Binding.Service<UnlockSubscriptionMessage>(
  "Azure.ServiceBus.UnlockSubscriptionMessage",
);
