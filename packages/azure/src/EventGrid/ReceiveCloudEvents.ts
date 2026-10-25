import type * as ns from "@distilled.cloud/azure/eventgrid-namespace";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { NamespaceTopicEventSubscription } from "./NamespaceTopicEventSubscription.ts";

export interface ReceiveCloudEventsRequest extends Omit<
  ns.ReceiveCloudEventsRequest,
  "endpoint" | "topicName" | "eventSubscriptionName"
> {}

/**
 * Receive (lock) a batch of CloudEvents from an Azure Event Grid namespace
 * topic subscription in pull (`queue`) mode, from any host.
 *
 * Each received event carries a `brokerProperties.lockToken`; settle it with
 * {@link AcknowledgeCloudEvents}, {@link ReleaseCloudEvents}, or
 * {@link RejectCloudEvents} before the lock expires.
 *
 * Binding assigns a custom role (`AzureEventGridReceiveRole`, one per stack)
 * with exactly the data action `Microsoft.EventGrid/events/receive/action`, on
 * the event subscription only (no built-in Event Grid role is narrower).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link ReceiveCloudEventsHttp}.
 *
 * ### Calling ReceiveCloudEvents
 * **Example:** ReceiveCloudEvents from a Function
 * ```typescript
 * // init
 * const receive = yield* Azure.EventGrid.ReceiveCloudEvents(workers);
 *
 * // runtime
 * const { value } = yield* receive({ maxEvents: 10, maxWaitTime: 10 });
 * for (const { event, brokerProperties } of value) {
 *   yield* Effect.log(event.type, brokerProperties.lockToken);
 * }
 * ```
 *
 * @binding
 * @category EventGrid
 */
export interface ReceiveCloudEvents extends Binding.Service<
  ReceiveCloudEvents,
  "Azure.EventGrid.ReceiveCloudEvents",
  (
    subscription: NamespaceTopicEventSubscription,
  ) => Effect.Effect<
    (
      request?: ReceiveCloudEventsRequest,
    ) => Effect.Effect<ns.ReceiveResult, ns.ReceiveCloudEventsError, RuntimeContext>
  >
> {}

export const ReceiveCloudEvents = Binding.Service<ReceiveCloudEvents>(
  "Azure.EventGrid.ReceiveCloudEvents",
);
