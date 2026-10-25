import * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { GetCallParticipant } from "./GetCallParticipant.ts";

/**
 * Implementation of {@link GetCallParticipant} over the distilled
 * `communication-call-automation` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.GetCallParticipant
 */
export const GetCallParticipantHttp = Layer.effect(
  GetCallParticipant,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.GetCallParticipant",
    operation: callAutomation.GetCallConnectionParticipant,
    grant: CommunicationRole.Data,
  }),
);
