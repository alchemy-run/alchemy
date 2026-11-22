import * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { StartCallTranscription } from "./StartCallTranscription.ts";

/**
 * Implementation of {@link StartCallTranscription} over the distilled
 * `communication-call-automation` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.StartCallTranscription
 */
export const StartCallTranscriptionHttp = Layer.effect(
  StartCallTranscription,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.StartCallTranscription",
    operation: callAutomation.StartCallMediaTranscription,
    grant: CommunicationRole.Data,
  }),
);
