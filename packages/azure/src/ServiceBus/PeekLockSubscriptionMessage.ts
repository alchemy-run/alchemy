import type * as messaging from "@distilled.cloud/azure/servicebus-messaging";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Subscription } from "./Subscription.ts";

/** The `PeekLockSubscriptionMessage` request without the `namespaceName`, `topicName` and `subscriptionName` the bound subscription supplies. */
export interface PeekLockSubscriptionMessageRequest extends Omit<
  messaging.PeekLockSubscriptionMessageRequest,
  "namespaceName" | "topicName" | "subscriptionName"
> {}

/**
 * Receive and lock the next message of an Azure Service Bus topic subscription
 * (Peek-Lock Message) on any host. Settle it with
 * {@link CompleteSubscriptionMessage}, {@link UnlockSubscriptionMessage} or
 * {@link RenewSubscriptionMessageLock}; without a message within `timeout`
 * seconds the response has no `body`.
 *
 * Binding assigns **Azure Service Bus Data Receiver**
 * (the `receive/action` data action) on the subscription only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link PeekLockSubscriptionMessageHttp}.
 *
 * ### Receiving Messages
 * **Example:** Peek-lock the next message
 * ```typescript
 * export default class Worker extends Azure.Functions.Function<Worker>()(
 *   "Worker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const subscription = yield* Audit;
 *     // init: assigns the role on the subscription only
 *     const peekLock = yield* Azure.ServiceBus.PeekLockSubscriptionMessage(subscription);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const message = yield* peekLock({ timeout: 5 });
 *         return yield* HttpServerResponse.json({ text: message.body && new TextDecoder().decode(message.body), location: message.location });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.ServiceBus.PeekLockSubscriptionMessageHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category ServiceBus
 */
export interface PeekLockSubscriptionMessage extends Binding.Service<
  PeekLockSubscriptionMessage,
  "Azure.ServiceBus.PeekLockSubscriptionMessage",
  (
    subscription: Subscription,
  ) => Effect.Effect<
    (
      request?: PeekLockSubscriptionMessageRequest,
    ) => Effect.Effect<
      messaging.PeekLockSubscriptionMessageResponse,
      messaging.PeekLockSubscriptionMessageError,
      RuntimeContext
    >
  >
> {}

export const PeekLockSubscriptionMessage = Binding.Service<PeekLockSubscriptionMessage>(
  "Azure.ServiceBus.PeekLockSubscriptionMessage",
);
