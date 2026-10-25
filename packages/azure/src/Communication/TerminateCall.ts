import type * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface TerminateCallRequest extends Omit<
  callAutomation.TerminateCallConnectionCallRequest,
  "endpoint"
> {}

/**
 * End the call for every participant.
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
 * Provide {@link TerminateCallHttp}.
 *
 * ### Calling TerminateCall
 * **Example:** TerminateCall from a Function
 * ```typescript
 * // init
 * const terminateCall = yield* Azure.Communication.TerminateCall(acs);
 *
 * // runtime
 * yield* terminateCall({ callConnectionId });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface TerminateCall extends Binding.Service<
  TerminateCall,
  "Azure.Communication.TerminateCall",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: TerminateCallRequest,
    ) => Effect.Effect<
      callAutomation.TerminateCallConnectionCallResponse,
      callAutomation.TerminateCallConnectionCallError,
      RuntimeContext
    >
  >
> {}

export const TerminateCall = Binding.Service<TerminateCall>("Azure.Communication.TerminateCall");
