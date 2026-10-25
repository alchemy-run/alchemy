import type * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface StartCallRecordingRequest extends Omit<
  callAutomation.StartCallRecordingRecordingRequest,
  "endpoint"
> {}

/**
 * Start recording a call.
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
 * Provide {@link StartCallRecordingHttp}.
 *
 * ### Calling StartCallRecording
 * **Example:** StartCallRecording from a Function
 * ```typescript
 * // init
 * const startCallRecording = yield* Azure.Communication.StartCallRecording(acs);
 *
 * // runtime
 * const recording = yield* startCallRecording({
 *   callLocator: { kind: "serverCallLocator", serverCallId },
 *   recordingContentType: "audio",
 * });
 * // recording.recordingId
 * ```
 *
 * @binding
 * @category Communication
 */
export interface StartCallRecording extends Binding.Service<
  StartCallRecording,
  "Azure.Communication.StartCallRecording",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request?: StartCallRecordingRequest,
    ) => Effect.Effect<
      callAutomation.RecordingStateResponse,
      callAutomation.StartCallRecordingRecordingError,
      RuntimeContext
    >
  >
> {}

export const StartCallRecording = Binding.Service<StartCallRecording>(
  "Azure.Communication.StartCallRecording",
);
