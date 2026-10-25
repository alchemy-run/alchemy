import type * as sipRouting from "@distilled.cloud/azure/communication-sip-routing";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface UpdateSipRoutingRequest extends Omit<
  sipRouting.UpdateSipRoutingRequest,
  "endpoint"
> {}

/**
 * Update the SIP trunks and routes of the communication service (direct
 * routing). Trunks merge by FQDN; `routes` replaces the whole route list. A
 * trunk's domain must be verified on the service first.
 *
 * Binding assigns a custom role (`AzureCommunicationDataRole`, one per stack)
 * with exactly the actions `Microsoft.Communication/CommunicationServices/Read`
 * and `/Write`, on the communication service only. The Communication
 * Services data plane has no data actions and denies Entra callers without
 * both, reads included.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link UpdateSipRoutingHttp}.
 *
 * ### Calling UpdateSipRouting
 * **Example:** UpdateSipRouting from a Function
 * ```typescript
 * // init
 * const updateSipRouting = yield* Azure.Communication.UpdateSipRouting(acs);
 *
 * // runtime
 * yield* updateSipRouting({
 *   trunks: { "sbc.contoso.com": { sipSignalingPort: 5061 } },
 *   routes: [{ name: "all", numberPattern: "^\\+[1-9][0-9]{3,23}$", trunks: ["sbc.contoso.com"] }],
 * });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface UpdateSipRouting extends Binding.Service<
  UpdateSipRouting,
  "Azure.Communication.UpdateSipRouting",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request?: UpdateSipRoutingRequest,
    ) => Effect.Effect<
      sipRouting.SipConfiguration,
      sipRouting.UpdateSipRoutingError,
      RuntimeContext
    >
  >
> {}

export const UpdateSipRouting = Binding.Service<UpdateSipRouting>(
  "Azure.Communication.UpdateSipRouting",
);
