import type * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface StopCallDtmfRecognitionRequest extends Omit<
  callAutomation.StopCallMediaContinuousDtmfRecognitionRequest,
  "endpoint"
> {}

/**
 * Stop continuous DTMF recognition for a participant.
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
 * Provide {@link StopCallDtmfRecognitionHttp}.
 *
 * ### Calling StopCallDtmfRecognition
 * **Example:** StopCallDtmfRecognition from a Function
 * ```typescript
 * // init
 * const stopCallDtmfRecognition = yield* Azure.Communication.StopCallDtmfRecognition(acs);
 *
 * // runtime
 * yield* stopCallDtmfRecognition({
 *   callConnectionId,
 *   targetParticipant: { phoneNumber: { value: "+14255550123" } },
 * });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface StopCallDtmfRecognition extends Binding.Service<
  StopCallDtmfRecognition,
  "Azure.Communication.StopCallDtmfRecognition",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: StopCallDtmfRecognitionRequest,
    ) => Effect.Effect<
      callAutomation.StopCallMediaContinuousDtmfRecognitionResponse,
      callAutomation.StopCallMediaContinuousDtmfRecognitionError,
      RuntimeContext
    >
  >
> {}

export const StopCallDtmfRecognition = Binding.Service<StopCallDtmfRecognition>(
  "Azure.Communication.StopCallDtmfRecognition",
);
