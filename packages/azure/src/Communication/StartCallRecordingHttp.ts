import * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { StartCallRecording } from "./StartCallRecording.ts";

/**
 * Implementation of {@link StartCallRecording} over the distilled
 * `communication-call-automation` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.StartCallRecording
 */
export const StartCallRecordingHttp = Layer.effect(
  StartCallRecording,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.StartCallRecording",
    operation: callAutomation.StartCallRecordingRecording,
    grant: CommunicationRole.Data,
  }),
);
