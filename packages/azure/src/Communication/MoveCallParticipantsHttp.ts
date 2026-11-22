import * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { MoveCallParticipants } from "./MoveCallParticipants.ts";

/**
 * Implementation of {@link MoveCallParticipants} over the distilled
 * `communication-call-automation` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.MoveCallParticipants
 */
export const MoveCallParticipantsHttp = Layer.effect(
  MoveCallParticipants,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.MoveCallParticipants",
    operation: callAutomation.MoveCallConnectionParticipants,
    grant: CommunicationRole.Data,
  }),
);
