import * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { CancelAddCallParticipant } from "./CancelAddCallParticipant.ts";

/**
 * Implementation of {@link CancelAddCallParticipant} over the distilled
 * `communication-call-automation` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.CancelAddCallParticipant
 */
export const CancelAddCallParticipantHttp = Layer.effect(
  CancelAddCallParticipant,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.CancelAddCallParticipant",
    operation: callAutomation.CallConnectionCancelAddParticipant,
    grant: CommunicationRole.Data,
  }),
);
