import * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { MuteCallParticipants } from "./MuteCallParticipants.ts";

/**
 * Implementation of {@link MuteCallParticipants} over the distilled
 * `communication-call-automation` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.MuteCallParticipants
 */
export const MuteCallParticipantsHttp = Layer.effect(
  MuteCallParticipants,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.MuteCallParticipants",
    operation: callAutomation.MuteCallConnection,
    grant: CommunicationRole.Data,
  }),
);
