import type * as dp from "@distilled.cloud/azure/eventgrid-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { TopicEndpointMissing } from "./DataPlaneTypes.ts";
import type { Topic } from "./Topic.ts";

/**
 * The `PublishCustomEventEvents` request without the `topicHostname` the
 * bound topic supplies: `body` is the array of events in your own JSON shape.
 */
export interface PublishCustomEventEventsRequest extends Omit<
  dp.PublishCustomEventEventsRequest,
  "topicHostname"
> {}

/**
 * Publish a batch of events in your own JSON shape to an Azure Event Grid
 * custom topic from any host. The topic's `inputSchemaMapping` maps your
 * fields to the Event Grid `id`, `eventType`, `subject`, and `dataVersion`.
 *
 * The topic must accept a custom schema (`inputSchema: "CustomEventSchema"`
 * with an `inputSchemaMapping`). The call fails with `TopicEndpointMissing`
 * when the topic reports no publish endpoint.
 *
 * Binding assigns the built-in **EventGrid Data Sender** role on the topic
 * only; its only data action is `Microsoft.EventGrid/events/send/action`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link PublishCustomEventEventsHttp}.
 *
 * ### Publishing Custom Events
 * **Example:** Publish `{ orderId, kind }` events from a Function
 * ```typescript
 * const Orders = Azure.EventGrid.Topic("Orders", {
 *   inputSchema: "CustomEventSchema",
 *   inputSchemaMapping: {
 *     id: { sourceField: "orderId" },
 *     eventType: { sourceField: "kind", defaultValue: "Order.Custom" },
 *     subject: { defaultValue: "orders" },
 *     dataVersion: { defaultValue: "1.0" },
 *   },
 * });
 *
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const topic = yield* Orders;
 *     // init: assigns the role on the topic only
 *     const publish = yield* Azure.EventGrid.PublishCustomEventEvents(topic);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         yield* publish({ body: [{ orderId: crypto.randomUUID(), kind: "Order.Created" }] });
 *         return HttpServerResponse.text("published");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.EventGrid.PublishCustomEventEventsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category EventGrid
 */
export interface PublishCustomEventEvents extends Binding.Service<
  PublishCustomEventEvents,
  "Azure.EventGrid.PublishCustomEventEvents",
  (
    topic: Topic,
  ) => Effect.Effect<
    (
      request: PublishCustomEventEventsRequest,
    ) => Effect.Effect<
      dp.PublishCustomEventEventsResponse,
      dp.PublishCustomEventEventsError | TopicEndpointMissing,
      RuntimeContext
    >
  >
> {}

export const PublishCustomEventEvents = Binding.Service<PublishCustomEventEvents>(
  "Azure.EventGrid.PublishCustomEventEvents",
);
