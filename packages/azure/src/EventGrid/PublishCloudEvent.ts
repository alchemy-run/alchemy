import type * as ns from "@distilled.cloud/azure/eventgrid-namespace";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { NamespaceTopic } from "./NamespaceTopic.ts";

export interface PublishCloudEventRequest extends Omit<
  ns.PublishCloudEventRequest,
  "endpoint" | "topicName"
> {}

/**
 * Publish one CloudEvent (v1.0) to an Azure Event Grid namespace topic from
 * any host.
 *
 * Binding assigns the built-in **EventGrid Data Sender** role on the namespace
 * topic only;
 * its only data action is `Microsoft.EventGrid/events/send/action`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link PublishCloudEventHttp}.
 *
 * ### Calling PublishCloudEvent
 * **Example:** PublishCloudEvent from a Function
 * ```typescript
 * // init
 * const publish = yield* Azure.EventGrid.PublishCloudEvent(orders);
 *
 * // runtime
 * yield* publish({
 *   id: orderId,
 *   source: "/orders",
 *   type: "Order.Created",
 *   specversion: "1.0",
 *   data: { orderId },
 * });
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
