import * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { UnholdCallParticipant } from "./UnholdCallParticipant.ts";

/**
 * Implementation of {@link UnholdCallParticipant} over the distilled
 * `communication-call-automation` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.UnholdCallParticipant
 */
export const UnholdCallParticipantHttp = Layer.effect(
  UnholdCallParticipant,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.UnholdCallParticipant",
    operation: callAutomation.CallMediaUnhold,
    grant: CommunicationRole.Data,
  }),
);
