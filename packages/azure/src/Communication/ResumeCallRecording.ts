import type * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface ResumeCallRecordingRequest extends Omit<
  callAutomation.ResumeCallRecordingRecordingRequest,
  "endpoint"
> {}

/**
 * Resume a paused call recording.
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
 * Provide {@link ResumeCallRecordingHttp}.
 *
 * ### Calling ResumeCallRecording
 * **Example:** ResumeCallRecording from a Function
 * ```typescript
 * // init
 * const resumeCallRecording = yield* Azure.Communication.ResumeCallRecording(acs);
 *
 * // runtime
 * yield* resumeCallRecording({ recordingId });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface ResumeCallRecording extends Binding.Service<
  ResumeCallRecording,
  "Azure.Communication.ResumeCallRecording",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: ResumeCallRecordingRequest,
    ) => Effect.Effect<
      callAutomation.ResumeCallRecordingRecordingResponse,
      callAutomation.ResumeCallRecordingRecordingError,
      RuntimeContext
    >
  >
> {}

export const ResumeCallRecording = Binding.Service<ResumeCallRecording>(
  "Azure.Communication.ResumeCallRecording",
);
