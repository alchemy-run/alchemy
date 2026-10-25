import type * as dp from "@distilled.cloud/azure/eventgrid-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { TopicEndpointMissing } from "./DataPlaneTypes.ts";
import type { Topic } from "./Topic.ts";

export interface PublishEventGridEventsRequest extends Omit<
  dp.PublishEventGridEventsRequest,
  "topicHostname"
> {}

/**
 * Publish a batch of events in the Event Grid schema to an Azure Event Grid
 * custom topic from any host.
 *
 * The topic must accept the Event Grid schema (`inputSchema:
 * "EventGridSchema"`, the default).
 *
 * Binding assigns the built-in **EventGrid Data Sender** role on the topic
 * only;
 * its only data action is `Microsoft.EventGrid/events/send/action`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link PublishEventGridEventsHttp}.
 *
 * ### Calling PublishEventGridEvents
 * **Example:** PublishEventGridEvents from a Function
 * ```typescript
 * // init
 * const publish = yield* Azure.EventGrid.PublishEventGridEvents(topic);
 *
 * // runtime
 * yield* publish({
 *   body: [
 *     {
 *       id: orderId,
 *       subject: `orders/${orderId}`,
 *       eventType: "Order.Created",
 *       eventTime: new Date().toISOString(),
 *       dataVersion: "1.0",
 *       data: { orderId },
 *     },
 *   ],
 * });
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
