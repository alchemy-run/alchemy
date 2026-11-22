import type * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface StartCallDtmfRecognitionRequest extends Omit<
  callAutomation.StartCallMediaContinuousDtmfRecognitionRequest,
  "endpoint"
> {}

/**
 * Start continuous DTMF recognition for a participant.
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
 * Provide {@link StartCallDtmfRecognitionHttp}.
 *
 * ### Calling StartCallDtmfRecognition
 * **Example:** StartCallDtmfRecognition from a Function
 * ```typescript
 * // init
 * const startCallDtmfRecognition = yield* Azure.Communication.StartCallDtmfRecognition(acs);
 *
 * // runtime
 * yield* startCallDtmfRecognition({
 *   callConnectionId,
 *   targetParticipant: { phoneNumber: { value: "+14255550123" } },
 * });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface StartCallDtmfRecognition extends Binding.Service<
  StartCallDtmfRecognition,
  "Azure.Communication.StartCallDtmfRecognition",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: StartCallDtmfRecognitionRequest,
    ) => Effect.Effect<
      callAutomation.StartCallMediaContinuousDtmfRecognitionResponse,
      callAutomation.StartCallMediaContinuousDtmfRecognitionError,
      RuntimeContext
    >
  >
> {}

export const StartCallDtmfRecognition = Binding.Service<StartCallDtmfRecognition>(
  "Azure.Communication.StartCallDtmfRecognition",
);
