import type * as ns from "@distilled.cloud/azure/eventgrid-namespace";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { NamespaceTopicEventSubscription } from "./NamespaceTopicEventSubscription.ts";

export interface ReleaseCloudEventsRequest extends Omit<
  ns.ReleaseCloudEventsRequest,
  "endpoint" | "topicName" | "eventSubscriptionName"
> {}

/**
 * Release received CloudEvents on an Azure Event Grid namespace topic
 * subscription (pull mode), from any host, so they can be received again
 * (optionally after `releaseDelayInSeconds`).
 *
 * Binding assigns a custom role (`AzureEventGridReceiveRole`, one per stack)
 * with exactly the data action `Microsoft.EventGrid/events/receive/action`, on
 * the event subscription only (no built-in Event Grid role is narrower).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link ReleaseCloudEventsHttp}.
 *
 * ### Calling ReleaseCloudEvents
 * **Example:** ReleaseCloudEvents from a Function
 * ```typescript
 * // init
 * const release = yield* Azure.EventGrid.ReleaseCloudEvents(workers);
 *
 * // runtime
 * yield* release({ lockTokens: [lockToken], releaseDelayInSeconds: "60" });
 * ```
 *
 * @binding
 * @category EventGrid
 */
export interface ReleaseCloudEvents extends Binding.Service<
  ReleaseCloudEvents,
  "Azure.EventGrid.ReleaseCloudEvents",
  (
    subscription: NamespaceTopicEventSubscription,
  ) => Effect.Effect<
    (
      request: ReleaseCloudEventsRequest,
    ) => Effect.Effect<ns.ReleaseResult, ns.ReleaseCloudEventsError, RuntimeContext>
  >
> {}

export const ReleaseCloudEvents = Binding.Service<ReleaseCloudEvents>(
  "Azure.EventGrid.ReleaseCloudEvents",
);
