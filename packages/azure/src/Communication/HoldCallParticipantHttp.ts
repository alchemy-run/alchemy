import * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { HoldCallParticipant } from "./HoldCallParticipant.ts";

/**
 * Implementation of {@link HoldCallParticipant} over the distilled
 * `communication-call-automation` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.HoldCallParticipant
 */
export const HoldCallParticipantHttp = Layer.effect(
  HoldCallParticipant,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.HoldCallParticipant",
    operation: callAutomation.CallMediaHold,
    grant: CommunicationRole.Data,
  }),
);
