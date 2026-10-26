import type * as dp from "@distilled.cloud/azure/eventgrid-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { TopicEndpointMissing } from "./DataPlaneTypes.ts";
import type { Topic } from "./Topic.ts";

/**
 * The `PublishEventGridEvents` request without the `topicHostname` the bound
 * topic supplies: `body` is the array of events to publish.
 */
export interface PublishEventGridEventsRequest extends Omit<
  dp.PublishEventGridEventsRequest,
  "topicHostname"
> {}

/**
 * Publish a batch of events in the Event Grid schema to an Azure Event Grid
 * custom topic from any host. Each event needs `id`, `subject`, `eventType`,
 * `eventTime`, `dataVersion`, and `data`.
 *
 * The topic must accept the Event Grid schema (`inputSchema:
 * "EventGridSchema"`, the default). The call fails with
 * `TopicEndpointMissing` when the topic reports no publish endpoint.
 *
 * Binding assigns the built-in **EventGrid Data Sender** role on the topic
 * only; its only data action is `Microsoft.EventGrid/events/send/action`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link PublishEventGridEventsHttp}.
 *
 * ### Publishing Events
 * **Example:** Publish an order event from a Function
 * ```typescript
 * const Orders = Azure.EventGrid.Topic("Orders", {});
 *
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const topic = yield* Orders;
 *     // init: assigns the role on the topic only
 *     const publish = yield* Azure.EventGrid.PublishEventGridEvents(topic);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         const orderId = crypto.randomUUID();
 *         yield* publish({
 *           body: [
 *             {
 *               id: orderId,
 *               subject: `orders/${orderId}`,
 *               eventType: "Order.Created",
 *               eventTime: new Date().toISOString(),
 *               dataVersion: "1.0",
 *               data: { orderId },
 *             },
 *           ],
 *         });
 *         return HttpServerResponse.text("published");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.EventGrid.PublishEventGridEventsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category EventGrid
 */
export interface PublishEventGridEvents extends Binding.Service<
  PublishEventGridEvents,
  "Azure.EventGrid.PublishEventGridEvents",
  (
    topic: Topic,
  ) => Effect.Effect<
    (
      request: PublishEventGridEventsRequest,
    ) => Effect.Effect<
      dp.PublishEventGridEventsResponse,
      dp.PublishEventGridEventsError | TopicEndpointMissing,
      RuntimeContext
    >
  >
> {}

export const PublishEventGridEvents = Binding.Service<PublishEventGridEvents>(
  "Azure.EventGrid.PublishEventGridEvents",
);
