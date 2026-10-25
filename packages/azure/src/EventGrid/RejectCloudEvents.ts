import type * as ns from "@distilled.cloud/azure/eventgrid-namespace";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { NamespaceTopicEventSubscription } from "./NamespaceTopicEventSubscription.ts";

export interface RejectCloudEventsRequest extends Omit<
  ns.RejectCloudEventsRequest,
  "endpoint" | "topicName" | "eventSubscriptionName"
> {}

/**
 * Reject received CloudEvents on an Azure Event Grid namespace topic
 * subscription (pull mode), from any host. Rejected events are dead-lettered
 * (when configured) and never delivered again.
 *
 * Binding assigns a custom role (`AzureEventGridReceiveRole`, one per stack)
 * with exactly the data action `Microsoft.EventGrid/events/receive/action`, on
 * the event subscription only (no built-in Event Grid role is narrower).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link RejectCloudEventsHttp}.
 *
 * ### Calling RejectCloudEvents
 * **Example:** RejectCloudEvents from a Function
 * ```typescript
 * // init
 * const reject = yield* Azure.EventGrid.RejectCloudEvents(workers);
 *
 * // runtime
 * yield* reject({ lockTokens: [lockToken] });
 * ```
 *
 * @binding
 * @category EventGrid
 */
export interface RejectCloudEvents extends Binding.Service<
  RejectCloudEvents,
  "Azure.EventGrid.RejectCloudEvents",
  (
    subscription: NamespaceTopicEventSubscription,
  ) => Effect.Effect<
    (
      request: RejectCloudEventsRequest,
    ) => Effect.Effect<ns.RejectResult, ns.RejectCloudEventsError, RuntimeContext>
  >
> {}

export const RejectCloudEvents = Binding.Service<RejectCloudEvents>(
  "Azure.EventGrid.RejectCloudEvents",
);
