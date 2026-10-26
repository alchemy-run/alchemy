import type * as ns from "@distilled.cloud/azure/eventgrid-namespace";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { NamespaceTopicEventSubscription } from "./NamespaceTopicEventSubscription.ts";

/**
 * The `ReleaseCloudEvents` request without the `endpoint`, `topicName`, and
 * `eventSubscriptionName` the bound event subscription supplies.
 * `lockTokens`: the `brokerProperties.lockToken` of each received event.
 * `releaseDelayInSeconds`: wait before redelivery, `"0"`, `"10"`, `"60"`,
 * `"600"`, or `"3600"` (default `"0"`).
 */
export interface ReleaseCloudEventsRequest extends Omit<
  ns.ReleaseCloudEventsRequest,
  "endpoint" | "topicName" | "eventSubscriptionName"
> {}

/**
 * Release received CloudEvents on an Azure Event Grid namespace topic
 * subscription (pull mode), from any host, so they can be received again.
 * Set `releaseDelayInSeconds` to delay the redelivery. A release counts as
 * a delivery attempt toward the subscription's `queue.maxDeliveryCount`.
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
 * Provide {@link ReleaseCloudEventsHttp}.
 *
 * ### Releasing Events
 * **Example:** Release events the host cannot process yet, with a 60-second delay
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
 *     const release = yield* Azure.EventGrid.ReleaseCloudEvents(workers);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         const { value } = yield* receive({ maxEvents: 10, maxWaitTime: 10 });
 *         if (value.length === 0) return HttpServerResponse.text("empty");
 *         yield* release({
 *           lockTokens: value.map((r) => r.brokerProperties.lockToken),
 *           releaseDelayInSeconds: "60",
 *         });
 *         return HttpServerResponse.text("released");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(
 *     Effect.provide(
 *       Layer.mergeAll(
 *         Azure.EventGrid.ReceiveCloudEventsHttp,
 *         Azure.EventGrid.ReleaseCloudEventsHttp,
 *       ),
 *     ),
 *   ),
 * ) {}
 * ```
 *
 * @binding
 * @category EventGrid
 */
export interface ReleaseCloudEvents extends Binding.Service<
  ReleaseCloudEvents,
  "Azure.EventGrid.ReleaseCloudEvents",
  (
    subscription: NamespaceTopicEventSubscription,
  ) => Effect.Effect<
    (
      request: ReleaseCloudEventsRequest,
    ) => Effect.Effect<ns.ReleaseResult, ns.ReleaseCloudEventsError, RuntimeContext>
  >
> {}

export const ReleaseCloudEvents = Binding.Service<ReleaseCloudEvents>(
  "Azure.EventGrid.ReleaseCloudEvents",
);
