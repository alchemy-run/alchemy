import type * as ns from "@distilled.cloud/azure/eventgrid-namespace";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { NamespaceTopicEventSubscription } from "./NamespaceTopicEventSubscription.ts";

/**
 * The `AcknowledgeCloudEvents` request without the `endpoint`, `topicName`, and
 * `eventSubscriptionName` the bound event subscription supplies.
 * `lockTokens`: the `brokerProperties.lockToken` of each received event.
 */
export interface AcknowledgeCloudEventsRequest extends Omit<
  ns.AcknowledgeCloudEventsRequest,
  "endpoint" | "topicName" | "eventSubscriptionName"
> {}

/**
 * Acknowledge received CloudEvents on an Azure Event Grid namespace topic
 * subscription (pull mode), from any host. Acknowledged events are removed
 * and never delivered again. Pass the `brokerProperties.lockToken` of each
 * event from {@link ReceiveCloudEvents}; the result lists
 * `succeededLockTokens` and `failedLockTokens` (for example, an expired
 * lock).
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
 * Provide {@link AcknowledgeCloudEventsHttp}.
 *
 * ### Acknowledging Events
 * **Example:** Acknowledge events after processing them
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
 *         if (value.length === 0) return HttpServerResponse.text("empty");
 *         const { succeededLockTokens, failedLockTokens } = yield* acknowledge({
 *           lockTokens: value.map((r) => r.brokerProperties.lockToken),
 *         });
 *         return HttpServerResponse.json({
 *           acknowledged: succeededLockTokens.length,
 *           failed: failedLockTokens.length,
 *         });
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
export interface AcknowledgeCloudEvents extends Binding.Service<
  AcknowledgeCloudEvents,
  "Azure.EventGrid.AcknowledgeCloudEvents",
  (
    subscription: NamespaceTopicEventSubscription,
  ) => Effect.Effect<
    (
      request: AcknowledgeCloudEventsRequest,
    ) => Effect.Effect<ns.AcknowledgeResult, ns.AcknowledgeCloudEventsError, RuntimeContext>
  >
> {}

export const AcknowledgeCloudEvents = Binding.Service<AcknowledgeCloudEvents>(
  "Azure.EventGrid.AcknowledgeCloudEvents",
);
