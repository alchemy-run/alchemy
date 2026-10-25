import type * as ns from "@distilled.cloud/azure/eventgrid-namespace";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { NamespaceTopic } from "./NamespaceTopic.ts";

export interface PublishCloudEventsRequest extends Omit<
  ns.PublishCloudEventsRequest,
  "endpoint" | "topicName"
> {}

/**
 * Publish a batch of CloudEvents (v1.0) to an Azure Event Grid namespace topic
 * from any host.
 *
 * Binding assigns the built-in **EventGrid Data Sender** role on the namespace
 * topic only;
 * its only data action is `Microsoft.EventGrid/events/send/action`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link PublishCloudEventsHttp}.
 *
 * ### Calling PublishCloudEvents
 * **Example:** PublishCloudEvents from a Function
 * ```typescript
 * // init
 * const publish = yield* Azure.EventGrid.PublishCloudEvents(orders);
 *
 * // runtime
 * yield* publish({
 *   body: orders.map((order) => ({
 *     id: order.id,
 *     source: "/orders",
 *     type: "Order.Created",
 *     specversion: "1.0",
 *     data: order,
 *   })),
 * });
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
