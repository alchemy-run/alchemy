import * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { RemoveCallParticipant } from "./RemoveCallParticipant.ts";

/**
 * Implementation of {@link RemoveCallParticipant} over the distilled
 * `communication-call-automation` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.RemoveCallParticipant
 */
export const RemoveCallParticipantHttp = Layer.effect(
  RemoveCallParticipant,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.RemoveCallParticipant",
    operation: callAutomation.RemoveCallConnectionParticipant,
    grant: CommunicationRole.Data,
  }),
);
