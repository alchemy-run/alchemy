import * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { UpdateCallTranscription } from "./UpdateCallTranscription.ts";

/**
 * Implementation of {@link UpdateCallTranscription} over the distilled
 * `communication-call-automation` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.UpdateCallTranscription
 */
export const UpdateCallTranscriptionHttp = Layer.effect(
  UpdateCallTranscription,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.UpdateCallTranscription",
    operation: callAutomation.UpdateCallMediaTranscription,
    grant: CommunicationRole.Data,
  }),
);
