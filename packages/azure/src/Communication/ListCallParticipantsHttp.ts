import * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { ListCallParticipants } from "./ListCallParticipants.ts";

/**
 * Implementation of {@link ListCallParticipants} over the distilled
 * `communication-call-automation` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.ListCallParticipants
 */
export const ListCallParticipantsHttp = Layer.effect(
  ListCallParticipants,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.ListCallParticipants",
    operation: callAutomation.GetCallConnectionParticipants,
    grant: CommunicationRole.Data,
  }),
);
