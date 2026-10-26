import type * as dp from "@distilled.cloud/azure/eventgrid-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { TopicEndpointMissing } from "./DataPlaneTypes.ts";
import type { Topic } from "./Topic.ts";

/**
 * The `PublishCloudEventEvents` request without the `topicHostname` the
 * bound topic supplies: `body` is the array of CloudEvents to publish.
 */
export interface PublishCloudEventEventsRequest extends Omit<
  dp.PublishCloudEventEventsRequest,
  "topicHostname"
> {}

/**
 * Publish a batch of CloudEvents (v1.0) to an Azure Event Grid custom topic
 * from any host. Each event needs `id`, `source`, `type`, and
 * `specversion: "1.0"`.
 *
 * The topic must accept CloudEvents (`inputSchema: "CloudEventSchemaV1_0"`).
 * The call fails with `TopicEndpointMissing` when the topic reports no
 * publish endpoint.
 *
 * Binding assigns the built-in **EventGrid Data Sender** role on the topic
 * only; its only data action is `Microsoft.EventGrid/events/send/action`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link PublishCloudEventEventsHttp}.
 *
 * ### Publishing CloudEvents
 * **Example:** Publish an order CloudEvent from a Function
 * ```typescript
 * const Orders = Azure.EventGrid.Topic("Orders", {
 *   inputSchema: "CloudEventSchemaV1_0",
 * });
 *
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const topic = yield* Orders;
 *     // init: assigns the role on the topic only
 *     const publish = yield* Azure.EventGrid.PublishCloudEventEvents(topic);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         const orderId = crypto.randomUUID();
 *         yield* publish({
 *           body: [
 *             {
 *               id: orderId,
 *               source: "/orders",
 *               type: "Order.Created",
 *               specversion: "1.0",
 *               datacontenttype: "application/json",
 *               data: { orderId },
 *             },
 *           ],
 *         });
 *         return HttpServerResponse.text("published");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.EventGrid.PublishCloudEventEventsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category EventGrid
 */
export interface PublishCloudEventEvents extends Binding.Service<
  PublishCloudEventEvents,
  "Azure.EventGrid.PublishCloudEventEvents",
  (
    topic: Topic,
  ) => Effect.Effect<
    (
      request: PublishCloudEventEventsRequest,
    ) => Effect.Effect<
      dp.PublishCloudEventEventsResponse,
      dp.PublishCloudEventEventsError | TopicEndpointMissing,
      RuntimeContext
    >
  >
> {}

export const PublishCloudEventEvents = Binding.Service<PublishCloudEventEvents>(
  "Azure.EventGrid.PublishCloudEventEvents",
);
