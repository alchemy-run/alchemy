import * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { GetCallRecording } from "./GetCallRecording.ts";

/**
 * Implementation of {@link GetCallRecording} over the distilled
 * `communication-call-automation` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.GetCallRecording
 */
export const GetCallRecordingHttp = Layer.effect(
  GetCallRecording,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.GetCallRecording",
    operation: callAutomation.GetCallRecordingRecordingProperties,
    grant: CommunicationRole.Data,
  }),
);
