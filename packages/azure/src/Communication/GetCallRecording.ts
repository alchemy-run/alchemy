import type * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface GetCallRecordingRequest extends Omit<
  callAutomation.GetCallRecordingRecordingPropertiesRequest,
  "endpoint"
> {}

/**
 * Read the state of a call recording.
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
 * Provide {@link GetCallRecordingHttp}.
 *
 * ### Calling GetCallRecording
 * **Example:** GetCallRecording from a Function
 * ```typescript
 * // init
 * const getCallRecording = yield* Azure.Communication.GetCallRecording(acs);
 *
 * // runtime
 * const recording = yield* getCallRecording({ recordingId });
 * // recording.recordingState
 * ```
 *
 * @binding
 * @category Communication
 */
export interface GetCallRecording extends Binding.Service<
  GetCallRecording,
  "Azure.Communication.GetCallRecording",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: GetCallRecordingRequest,
    ) => Effect.Effect<
      callAutomation.RecordingStateResponse,
      callAutomation.GetCallRecordingRecordingPropertiesError,
      RuntimeContext
    >
  >
> {}

export const GetCallRecording = Binding.Service<GetCallRecording>(
  "Azure.Communication.GetCallRecording",
);
