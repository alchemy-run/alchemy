import * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { ResumeCallRecording } from "./ResumeCallRecording.ts";

/**
 * Implementation of {@link ResumeCallRecording} over the distilled
 * `communication-call-automation` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.ResumeCallRecording
 */
export const ResumeCallRecordingHttp = Layer.effect(
  ResumeCallRecording,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.ResumeCallRecording",
    operation: callAutomation.ResumeCallRecordingRecording,
    grant: CommunicationRole.Data,
  }),
);
