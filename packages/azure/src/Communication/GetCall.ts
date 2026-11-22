import type * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface GetCallRequest extends Omit<
  callAutomation.GetCallConnectionCallRequest,
  "endpoint"
> {}

/**
 * Read the properties of an ongoing call.
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
 * Provide {@link GetCallHttp}.
 *
 * ### Calling GetCall
 * **Example:** GetCall from a Function
 * ```typescript
 * // init
 * const getCall = yield* Azure.Communication.GetCall(acs);
 *
 * // runtime
 * const call = yield* getCall({ callConnectionId });
 * // call.callConnectionState
 * ```
 *
 * @binding
 * @category Communication
 */
export interface GetCall extends Binding.Service<
  GetCall,
  "Azure.Communication.GetCall",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: GetCallRequest,
    ) => Effect.Effect<
      callAutomation.CallConnectionProperties,
      callAutomation.GetCallConnectionCallError,
      RuntimeContext
    >
  >
> {}

export const GetCall = Binding.Service<GetCall>("Azure.Communication.GetCall");
