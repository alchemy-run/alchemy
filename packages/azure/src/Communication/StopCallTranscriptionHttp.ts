import * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { StopCallTranscription } from "./StopCallTranscription.ts";

/**
 * Implementation of {@link StopCallTranscription} over the distilled
 * `communication-call-automation` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.StopCallTranscription
 */
export const StopCallTranscriptionHttp = Layer.effect(
  StopCallTranscription,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.StopCallTranscription",
    operation: callAutomation.StopCallMediaTranscription,
    grant: CommunicationRole.Data,
  }),
);
