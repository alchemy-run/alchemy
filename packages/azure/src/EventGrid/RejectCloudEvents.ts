import type * as ns from "@distilled.cloud/azure/eventgrid-namespace";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { NamespaceTopicEventSubscription } from "./NamespaceTopicEventSubscription.ts";

/**
 * The `RejectCloudEvents` request without the `endpoint`, `topicName`, and
 * `eventSubscriptionName` the bound event subscription supplies.
 * `lockTokens`: the `brokerProperties.lockToken` of each received event.
 */
export interface RejectCloudEventsRequest extends Omit<
  ns.RejectCloudEventsRequest,
  "endpoint" | "topicName" | "eventSubscriptionName"
> {}

/**
 * Reject received CloudEvents on an Azure Event Grid namespace topic
 * subscription (pull mode), from any host. Rejected events are
 * dead-lettered (when the subscription has a dead-letter destination) and
 * never delivered again. Reject an event you can never process, such as a
 * malformed payload.
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
 * Provide {@link RejectCloudEventsHttp}.
 *
 * ### Rejecting Events
 * **Example:** Reject events of an unknown type
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
 *     const reject = yield* Azure.EventGrid.RejectCloudEvents(workers);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         const { value } = yield* receive({ maxEvents: 10, maxWaitTime: 10 });
 *         const unknown = value.filter((r) => r.event.type !== "Order.Created");
 *         if (unknown.length > 0) {
 *           yield* reject({
 *             lockTokens: unknown.map((r) => r.brokerProperties.lockToken),
 *           });
 *         }
 *         return HttpServerResponse.json({ rejected: unknown.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(
 *     Effect.provide(
 *       Layer.mergeAll(
 *         Azure.EventGrid.ReceiveCloudEventsHttp,
 *         Azure.EventGrid.RejectCloudEventsHttp,
 *       ),
 *     ),
 *   ),
 * ) {}
 * ```
 *
 * @binding
 * @category EventGrid
 */
export interface RejectCloudEvents extends Binding.Service<
  RejectCloudEvents,
  "Azure.EventGrid.RejectCloudEvents",
  (
    subscription: NamespaceTopicEventSubscription,
  ) => Effect.Effect<
    (
      request: RejectCloudEventsRequest,
    ) => Effect.Effect<ns.RejectResult, ns.RejectCloudEventsError, RuntimeContext>
  >
> {}

export const RejectCloudEvents = Binding.Service<RejectCloudEvents>(
  "Azure.EventGrid.RejectCloudEvents",
);
