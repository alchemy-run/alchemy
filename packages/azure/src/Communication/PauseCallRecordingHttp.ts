import * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { PauseCallRecording } from "./PauseCallRecording.ts";

/**
 * Implementation of {@link PauseCallRecording} over the distilled
 * `communication-call-automation` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.PauseCallRecording
 */
export const PauseCallRecordingHttp = Layer.effect(
  PauseCallRecording,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.PauseCallRecording",
    operation: callAutomation.PauseCallRecordingRecording,
    grant: CommunicationRole.Data,
  }),
);
