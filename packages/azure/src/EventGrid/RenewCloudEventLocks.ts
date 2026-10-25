import type * as ns from "@distilled.cloud/azure/eventgrid-namespace";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { NamespaceTopicEventSubscription } from "./NamespaceTopicEventSubscription.ts";

export interface RenewCloudEventLocksRequest extends Omit<
  ns.RenewCloudEventLocksRequest,
  "endpoint" | "topicName" | "eventSubscriptionName"
> {}

/**
 * Renew the locks of received CloudEvents on an Azure Event Grid namespace
 * topic subscription (pull mode), from any host, so a slow consumer keeps
 * them.
 *
 * Binding assigns a custom role (`AzureEventGridReceiveRole`, one per stack)
 * with exactly the data action `Microsoft.EventGrid/events/receive/action`, on
 * the event subscription only (no built-in Event Grid role is narrower).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link RenewCloudEventLocksHttp}.
 *
 * ### Calling RenewCloudEventLocks
 * **Example:** RenewCloudEventLocks from a Function
 * ```typescript
 * // init
 * const renewLocks = yield* Azure.EventGrid.RenewCloudEventLocks(workers);
 *
 * // runtime
 * yield* renewLocks({ lockTokens: [lockToken] });
 * ```
 *
 * @binding
 * @category EventGrid
 */
export interface RenewCloudEventLocks extends Binding.Service<
  RenewCloudEventLocks,
  "Azure.EventGrid.RenewCloudEventLocks",
  (
    subscription: NamespaceTopicEventSubscription,
  ) => Effect.Effect<
    (
      request: RenewCloudEventLocksRequest,
    ) => Effect.Effect<ns.RenewCloudEventLocksResult, ns.RenewCloudEventLocksError, RuntimeContext>
  >
> {}

export const RenewCloudEventLocks = Binding.Service<RenewCloudEventLocks>(
  "Azure.EventGrid.RenewCloudEventLocks",
);
