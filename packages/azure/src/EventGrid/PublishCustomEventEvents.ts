import type * as dp from "@distilled.cloud/azure/eventgrid-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { TopicEndpointMissing } from "./DataPlaneTypes.ts";
import type { Topic } from "./Topic.ts";

export interface PublishCustomEventEventsRequest extends Omit<
  dp.PublishCustomEventEventsRequest,
  "topicHostname"
> {}

/**
 * Publish a batch of events in your own JSON shape to an Azure Event Grid
 * custom topic from any host.
 *
 * The topic must accept a custom schema (`inputSchema: "CustomEventSchema"`
 * with an `inputSchemaMapping`).
 *
 * Binding assigns the built-in **EventGrid Data Sender** role on the topic
 * only;
 * its only data action is `Microsoft.EventGrid/events/send/action`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link PublishCustomEventEventsHttp}.
 *
 * ### Calling PublishCustomEventEvents
 * **Example:** PublishCustomEventEvents from a Function
 * ```typescript
 * // init
 * const publish = yield* Azure.EventGrid.PublishCustomEventEvents(topic);
 *
 * // runtime
 * yield* publish({ body: [{ orderId, kind: "created", at: new Date().toISOString() }] });
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
