import type * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface PauseCallRecordingRequest extends Omit<
  callAutomation.PauseCallRecordingRecordingRequest,
  "endpoint"
> {}

/**
 * Pause a call recording.
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
 * Provide {@link PauseCallRecordingHttp}.
 *
 * ### Calling PauseCallRecording
 * **Example:** PauseCallRecording from a Function
 * ```typescript
 * // init
 * const pauseCallRecording = yield* Azure.Communication.PauseCallRecording(acs);
 *
 * // runtime
 * yield* pauseCallRecording({ recordingId });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface PauseCallRecording extends Binding.Service<
  PauseCallRecording,
  "Azure.Communication.PauseCallRecording",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: PauseCallRecordingRequest,
    ) => Effect.Effect<
      callAutomation.PauseCallRecordingRecordingResponse,
      callAutomation.PauseCallRecordingRecordingError,
      RuntimeContext
    >
  >
> {}

export const PauseCallRecording = Binding.Service<PauseCallRecording>(
  "Azure.Communication.PauseCallRecording",
);
