import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { ReadServiceBusSubscriptionClient } from "./ServiceBusTypes.ts";
import type { Subscription } from "./Subscription.ts";

/**
 * Receive and settle the messages of an Azure Service Bus topic
 * subscription on any host: peek-lock with `receive` and then `complete`,
 * `abandon` or `renewLock`, or take a message for good with
 * `receiveAndDelete`. A subscription has no send side (publish to its topic
 * with {@link TopicWrite}), so there is no `SubscriptionWrite`.
 *
 * Binding assigns **Azure Service Bus Data Receiver**
 * (the `receive/action` data action) on the subscription only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link SubscriptionReadHttp}.
 *
 * ### Reading a Subscription
 * **Example:** Drain the next event
 * ```typescript
 * export default class Auditor extends Azure.Functions.Function<Auditor>()(
 *   "Auditor",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const subscription = yield* Audit;
 *     const audit = yield* Azure.ServiceBus.SubscriptionRead(subscription);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const message = yield* audit.receive({ timeoutSeconds: 5 });
 *         if (message === undefined) return HttpServerResponse.text("empty");
 *         yield* audit.complete(message);
 *         return yield* HttpServerResponse.json({ text: message.text });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.ServiceBus.SubscriptionReadHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category ServiceBus
 */
export interface SubscriptionRead extends Binding.Service<
  SubscriptionRead,
  "Azure.ServiceBus.SubscriptionRead",
  (subscription: Subscription) => Effect.Effect<ReadServiceBusSubscriptionClient>
> {}

export const SubscriptionRead = Binding.Service<SubscriptionRead>(
  "Azure.ServiceBus.SubscriptionRead",
);
