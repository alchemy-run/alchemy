import type * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface HangUpCallRequest extends Omit<
  callAutomation.CallConnectionHangupCallRequest,
  "endpoint"
> {}

/**
 * Make Call Automation leave the call. The call goes on while other
 * participants remain; use `TerminateCall` to end it for everyone.
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
 * Provide {@link HangUpCallHttp}.
 *
 * ### Calling HangUpCall
 * **Example:** HangUpCall from a Function
 * ```typescript
 * // init
 * const hangUpCall = yield* Azure.Communication.HangUpCall(acs);
 *
 * // runtime
 * yield* hangUpCall({ callConnectionId });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface HangUpCall extends Binding.Service<
  HangUpCall,
  "Azure.Communication.HangUpCall",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: HangUpCallRequest,
    ) => Effect.Effect<
      callAutomation.CallConnectionHangupCallResponse,
      callAutomation.CallConnectionHangupCallError,
      RuntimeContext
    >
  >
> {}

export const HangUpCall = Binding.Service<HangUpCall>("Azure.Communication.HangUpCall");
