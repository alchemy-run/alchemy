import type * as ns from "@distilled.cloud/azure/eventgrid-namespace";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { NamespaceTopic } from "./NamespaceTopic.ts";

/**
 * The `PublishCloudEvent` request without the `endpoint` and `topicName` the
 * bound namespace topic supplies: the CloudEvent itself (`id`, `source`,
 * `type`, `specversion`, `data`, …).
 */
export interface PublishCloudEventRequest extends Omit<
  ns.PublishCloudEventRequest,
  "endpoint" | "topicName"
> {}

/**
 * Publish one CloudEvent (v1.0) to an Azure Event Grid namespace topic from
 * any host. The request is the event: `id`, `source`, `type`,
 * `specversion: "1.0"`, and optional `data`. Use {@link PublishCloudEvents}
 * to send a batch.
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
 * Provide {@link PublishCloudEventHttp}.
 *
 * ### Publishing a CloudEvent
 * **Example:** Publish an order event from a Function
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
 *     const publish = yield* Azure.EventGrid.PublishCloudEvent(orders);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         const orderId = crypto.randomUUID();
 *         yield* publish({
 *           id: orderId,
 *           source: "/orders",
 *           type: "Order.Created",
 *           specversion: "1.0",
 *           data: { orderId },
 *         });
 *         return HttpServerResponse.text("published");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.EventGrid.PublishCloudEventHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category EventGrid
 */
export interface PublishCloudEvent extends Binding.Service<
  PublishCloudEvent,
  "Azure.EventGrid.PublishCloudEvent",
  (
    topic: NamespaceTopic,
  ) => Effect.Effect<
    (
      request: PublishCloudEventRequest,
    ) => Effect.Effect<ns.PublishCloudEventResponse, ns.PublishCloudEventError, RuntimeContext>
  >
> {}

export const PublishCloudEvent = Binding.Service<PublishCloudEvent>(
  "Azure.EventGrid.PublishCloudEvent",
);
