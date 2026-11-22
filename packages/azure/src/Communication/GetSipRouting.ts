import type * as sipRouting from "@distilled.cloud/azure/communication-sip-routing";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface GetSipRoutingRequest extends Omit<sipRouting.GetSipRoutingRequest, "endpoint"> {}

/**
 * Read the SIP trunks and routes of the communication service (direct
 * routing).
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
 * Provide {@link GetSipRoutingHttp}.
 *
 * ### Calling GetSipRouting
 * **Example:** GetSipRouting from a Function
 * ```typescript
 * // init
 * const getSipRouting = yield* Azure.Communication.GetSipRouting(acs);
 *
 * // runtime
 * const sip = yield* getSipRouting();
 * // sip.trunks, sip.routes
 * ```
 *
 * @binding
 * @category Communication
 */
export interface GetSipRouting extends Binding.Service<
  GetSipRouting,
  "Azure.Communication.GetSipRouting",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request?: GetSipRoutingRequest,
    ) => Effect.Effect<sipRouting.SipConfiguration, sipRouting.GetSipRoutingError, RuntimeContext>
  >
> {}

export const GetSipRouting = Binding.Service<GetSipRouting>("Azure.Communication.GetSipRouting");
