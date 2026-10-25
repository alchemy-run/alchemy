import type * as dp from "@distilled.cloud/azure/eventgrid-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { TopicEndpointMissing } from "./DataPlaneTypes.ts";
import type { Topic } from "./Topic.ts";

export interface PublishCloudEventEventsRequest extends Omit<
  dp.PublishCloudEventEventsRequest,
  "topicHostname"
> {}

/**
 * Publish a batch of CloudEvents (v1.0) to an Azure Event Grid custom topic
 * from any host.
 *
 * The topic must accept CloudEvents (`inputSchema: "CloudEventSchemaV1_0"`).
 *
 * Binding assigns the built-in **EventGrid Data Sender** role on the topic
 * only;
 * its only data action is `Microsoft.EventGrid/events/send/action`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link PublishCloudEventEventsHttp}.
 *
 * ### Calling PublishCloudEventEvents
 * **Example:** PublishCloudEventEvents from a Function
 * ```typescript
 * // init
 * const publish = yield* Azure.EventGrid.PublishCloudEventEvents(topic);
 *
 * // runtime
 * yield* publish({
 *   body: [
 *     {
 *       id: orderId,
 *       source: "/orders",
 *       type: "Order.Created",
 *       specversion: "1.0",
 *       data: { orderId },
 *     },
 *   ],
 * });
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
