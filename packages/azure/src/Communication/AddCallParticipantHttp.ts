import * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Layer from "effect/Layer";
import { AddCallParticipant } from "./AddCallParticipant.ts";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";

/**
 * Implementation of {@link AddCallParticipant} over the distilled
 * `communication-call-automation` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.AddCallParticipant
 */
export const AddCallParticipantHttp = Layer.effect(
  AddCallParticipant,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.AddCallParticipant",
    operation: callAutomation.AddCallConnectionParticipant,
    grant: CommunicationRole.Data,
  }),
);
