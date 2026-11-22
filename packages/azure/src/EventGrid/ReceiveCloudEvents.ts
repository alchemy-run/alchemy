import type * as ns from "@distilled.cloud/azure/eventgrid-namespace";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { NamespaceTopicEventSubscription } from "./NamespaceTopicEventSubscription.ts";

/**
 * The `ReceiveCloudEvents` request without the `endpoint`, `topicName`, and
 * `eventSubscriptionName` the bound event subscription supplies.
 * `maxEvents`: events to receive, 1–100 (default 1). `maxWaitTime`: seconds
 * the server waits for an event, 10–120 (default 60).
 */
export interface ReceiveCloudEventsRequest extends Omit<
  ns.ReceiveCloudEventsRequest,
  "endpoint" | "topicName" | "eventSubscriptionName"
> {}

/**
 * Receive (lock) a batch of CloudEvents from an Azure Event Grid namespace
 * topic subscription in pull (`queue`) mode, from any host. Call it with no
 * request to receive one event, waiting up to 60 seconds.
 *
 * Each received event carries a `brokerProperties.lockToken`. Settle it with
 * {@link AcknowledgeCloudEvents}, {@link ReleaseCloudEvents}, or
 * {@link RejectCloudEvents} before the lock expires (the subscription's
 * `queue.receiveLockDurationInSeconds`), or extend the lock with
 * {@link RenewCloudEventLocks}.
 *
 * Binding assigns a custom role (`AzureEventGridReceiveRole`, one per stack)
 * with exactly the data action `Microsoft.EventGrid/events/receive/action`,
 * on the event subscription only (no built-in Event Grid role is narrower).
 * Bind the same subscription to every receive and settle binding the host
 * uses; they share this role.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link ReceiveCloudEventsHttp}.
 *
 * ### Receiving Events
 * **Example:** Receive, process, and acknowledge events
 * ```typescript
 * const Events = Azure.EventGrid.Namespace("Events", {});
 * const Orders = Effect.gen(function* () {
 *   const namespace = yield* Events;
 *   return yield* Azure.EventGrid.NamespaceTopic("Orders", {
 *     namespace: namespace.namespaceName,
 *   });
 * });
 * // a pull (`queue`) subscription
 * const Workers = Effect.gen(function* () {
 *   const namespace = yield* Events;
 *   const orders = yield* Orders;
 *   return yield* Azure.EventGrid.NamespaceTopicEventSubscription("Workers", {
 *     namespace: namespace.namespaceName,
 *     topic: orders.namespaceTopicName,
 *     queue: { receiveLockDurationInSeconds: 120 },
 *   });
 * });
 *
 * export default class Worker extends Azure.Functions.Function<Worker>()(
 *   "Worker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const workers = yield* Workers;
 *     // init: assigns the role on the event subscription only
 *     const receive = yield* Azure.EventGrid.ReceiveCloudEvents(workers);
 *     const acknowledge = yield* Azure.EventGrid.AcknowledgeCloudEvents(workers);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         const { value } = yield* receive({ maxEvents: 10, maxWaitTime: 10 });
 *         for (const { event } of value) {
 *           yield* Effect.log(`${event.type} ${event.id}`);
 *         }
 *         if (value.length > 0) {
 *           yield* acknowledge({
 *             lockTokens: value.map((r) => r.brokerProperties.lockToken),
 *           });
 *         }
 *         return HttpServerResponse.json({ processed: value.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(
 *     Effect.provide(
 *       Layer.mergeAll(
 *         Azure.EventGrid.ReceiveCloudEventsHttp,
 *         Azure.EventGrid.AcknowledgeCloudEventsHttp,
 *       ),
 *     ),
 *   ),
 * ) {}
 * ```
 *
 * @binding
 * @category EventGrid
 */
export interface ReceiveCloudEvents extends Binding.Service<
  ReceiveCloudEvents,
  "Azure.EventGrid.ReceiveCloudEvents",
  (
    subscription: NamespaceTopicEventSubscription,
  ) => Effect.Effect<
    (
      request?: ReceiveCloudEventsRequest,
    ) => Effect.Effect<ns.ReceiveResult, ns.ReceiveCloudEventsError, RuntimeContext>
  >
> {}

export const ReceiveCloudEvents = Binding.Service<ReceiveCloudEvents>(
  "Azure.EventGrid.ReceiveCloudEvents",
);
