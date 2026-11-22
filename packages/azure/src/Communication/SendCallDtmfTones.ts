import type * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface SendCallDtmfTonesRequest extends Omit<
  callAutomation.SendCallMediaDtmfTonesRequest,
  "endpoint"
> {}

/**
 * Send DTMF tones to a participant.
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
 * Provide {@link SendCallDtmfTonesHttp}.
 *
 * ### Calling SendCallDtmfTones
 * **Example:** SendCallDtmfTones from a Function
 * ```typescript
 * // init
 * const sendCallDtmfTones = yield* Azure.Communication.SendCallDtmfTones(acs);
 *
 * // runtime
 * yield* sendCallDtmfTones({
 *   callConnectionId,
 *   tones: ["one", "two", "pound"],
 *   targetParticipant: { phoneNumber: { value: "+14255550123" } },
 * });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface SendCallDtmfTones extends Binding.Service<
  SendCallDtmfTones,
  "Azure.Communication.SendCallDtmfTones",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: SendCallDtmfTonesRequest,
    ) => Effect.Effect<
      callAutomation.SendDtmfTonesResult,
      callAutomation.SendCallMediaDtmfTonesError,
      RuntimeContext
    >
  >
> {}

export const SendCallDtmfTones = Binding.Service<SendCallDtmfTones>(
  "Azure.Communication.SendCallDtmfTones",
);
