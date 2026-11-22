import type * as messaging from "@distilled.cloud/azure/servicebus-messaging";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Subscription } from "./Subscription.ts";

/** The `RenewSubscriptionMessageLock` request without the `namespaceName`, `topicName` and `subscriptionName` the bound subscription supplies. */
export interface RenewSubscriptionMessageLockRequest extends Omit<
  messaging.RenewSubscriptionMessageLockRequest,
  "namespaceName" | "topicName" | "subscriptionName"
> {}

/**
 * Extend the lock on a peek-locked message of an Azure Service Bus topic
 * subscription (Renew-Lock for a Message) on any host. Fails `MessageLockLost`
 * when the lock expired.
 *
 * Binding assigns **Azure Service Bus Data Receiver**
 * (the `receive/action` data action) on the subscription only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link RenewSubscriptionMessageLockHttp}.
 *
 * ### Settling Messages
 * **Example:** Keep a long-running message locked
 * ```typescript
 * export default class Worker extends Azure.Functions.Function<Worker>()(
 *   "Worker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const subscription = yield* Audit;
 *     // init: assigns the role on the subscription only
 *     const renewLock = yield* Azure.ServiceBus.RenewSubscriptionMessageLock(subscription);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // messageId and lockToken: the lock URI (`location`) of a peek-locked message
 *         yield* renewLock({ messageId, lockToken });
 *         return yield* HttpServerResponse.json({ renewed: true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.ServiceBus.RenewSubscriptionMessageLockHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category ServiceBus
 */
export interface RenewSubscriptionMessageLock extends Binding.Service<
  RenewSubscriptionMessageLock,
  "Azure.ServiceBus.RenewSubscriptionMessageLock",
  (
    subscription: Subscription,
  ) => Effect.Effect<
    (
      request: RenewSubscriptionMessageLockRequest,
    ) => Effect.Effect<
      messaging.RenewSubscriptionMessageLockResponse,
      messaging.RenewSubscriptionMessageLockError,
      RuntimeContext
    >
  >
> {}

export const RenewSubscriptionMessageLock = Binding.Service<RenewSubscriptionMessageLock>(
  "Azure.ServiceBus.RenewSubscriptionMessageLock",
);
