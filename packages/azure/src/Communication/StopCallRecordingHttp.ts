import * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { StopCallRecording } from "./StopCallRecording.ts";

/**
 * Implementation of {@link StopCallRecording} over the distilled
 * `communication-call-automation` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.StopCallRecording
 */
export const StopCallRecordingHttp = Layer.effect(
  StopCallRecording,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.StopCallRecording",
    operation: callAutomation.StopCallRecordingRecording,
    grant: CommunicationRole.Data,
  }),
);
