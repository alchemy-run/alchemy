import type * as ns from "@distilled.cloud/azure/eventgrid-namespace";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { NamespaceTopicEventSubscription } from "./NamespaceTopicEventSubscription.ts";

export interface AcknowledgeCloudEventsRequest extends Omit<
  ns.AcknowledgeCloudEventsRequest,
  "endpoint" | "topicName" | "eventSubscriptionName"
> {}

/**
 * Acknowledge received CloudEvents on an Azure Event Grid namespace topic
 * subscription (pull mode), from any host. Acknowledged events are removed and
 * never delivered again.
 *
 * Binding assigns a custom role (`AzureEventGridReceiveRole`, one per stack)
 * with exactly the data action `Microsoft.EventGrid/events/receive/action`, on
 * the event subscription only (no built-in Event Grid role is narrower).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link AcknowledgeCloudEventsHttp}.
 *
 * ### Calling AcknowledgeCloudEvents
 * **Example:** AcknowledgeCloudEvents from a Function
 * ```typescript
 * // init
 * const acknowledge = yield* Azure.EventGrid.AcknowledgeCloudEvents(workers);
 *
 * // runtime
 * const { succeededLockTokens, failedLockTokens } = yield* acknowledge({
 *   lockTokens: received.value.map((r) => r.brokerProperties.lockToken),
 * });
 * ```
 *
 * @binding
 * @category EventGrid
 */
export interface AcknowledgeCloudEvents extends Binding.Service<
  AcknowledgeCloudEvents,
  "Azure.EventGrid.AcknowledgeCloudEvents",
  (
    subscription: NamespaceTopicEventSubscription,
  ) => Effect.Effect<
    (
      request: AcknowledgeCloudEventsRequest,
    ) => Effect.Effect<ns.AcknowledgeResult, ns.AcknowledgeCloudEventsError, RuntimeContext>
  >
> {}

export const AcknowledgeCloudEvents = Binding.Service<AcknowledgeCloudEvents>(
  "Azure.EventGrid.AcknowledgeCloudEvents",
);
