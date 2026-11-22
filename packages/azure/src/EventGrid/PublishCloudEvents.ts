import type * as ns from "@distilled.cloud/azure/eventgrid-namespace";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { NamespaceTopic } from "./NamespaceTopic.ts";

/**
 * The `PublishCloudEvents` request without the `endpoint` and `topicName`
 * the bound namespace topic supplies: `body` is the array of CloudEvents.
 */
export interface PublishCloudEventsRequest extends Omit<
  ns.PublishCloudEventsRequest,
  "endpoint" | "topicName"
> {}

/**
 * Publish a batch of CloudEvents (v1.0) to an Azure Event Grid namespace
 * topic from any host. Each event needs `id`, `source`, `type`, and
 * `specversion: "1.0"`.
 *
 * Binding assigns the built-in **EventGrid Data Sender** role on the
 * namespace topic only; its only data action is
 * `Microsoft.EventGrid/events/send/action`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link PublishCloudEventsHttp}.
 *
 * ### Publishing CloudEvents
 * **Example:** Publish a batch of order events from a Function
 * ```typescript
 * const Events = Azure.EventGrid.Namespace("Events", {});
 * const Orders = Effect.gen(function* () {
 *   const namespace = yield* Events;
 *   return yield* Azure.EventGrid.NamespaceTopic("Orders", {
 *     namespace: namespace.namespaceName,
 *   });
 * });
 *
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const orders = yield* Orders;
 *     // init: assigns the role on the namespace topic only
 *     const publish = yield* Azure.EventGrid.PublishCloudEvents(orders);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         const ids = [crypto.randomUUID(), crypto.randomUUID()];
 *         yield* publish({
 *           body: ids.map((id) => ({
 *             id,
 *             source: "/orders",
 *             type: "Order.Created",
 *             specversion: "1.0",
 *             data: { orderId: id },
 *           })),
 *         });
 *         return HttpServerResponse.json({ published: ids });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.EventGrid.PublishCloudEventsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category EventGrid
 */
export interface PublishCloudEvents extends Binding.Service<
  PublishCloudEvents,
  "Azure.EventGrid.PublishCloudEvents",
  (
    topic: NamespaceTopic,
  ) => Effect.Effect<
    (
      request: PublishCloudEventsRequest,
    ) => Effect.Effect<ns.PublishCloudEventsResponse, ns.PublishCloudEventsError, RuntimeContext>
  >
> {}

export const PublishCloudEvents = Binding.Service<PublishCloudEvents>(
  "Azure.EventGrid.PublishCloudEvents",
);
