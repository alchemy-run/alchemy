import * as rooms from "@distilled.cloud/azure/communication-rooms";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { UpdateRoomParticipants } from "./UpdateRoomParticipants.ts";

/**
 * Implementation of {@link UpdateRoomParticipants} over the distilled `communication-rooms`
 * data plane. Assigns the custom `AzureCommunicationDataRole` on the
 * communication service.
 *
 * @layer
 * @provides Azure.Communication.UpdateRoomParticipants
 */
export const UpdateRoomParticipantsHttp = Layer.effect(
  UpdateRoomParticipants,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.UpdateRoomParticipants",
    operation: rooms.UpdateParticipant,
    grant: CommunicationRole.Data,
  }),
);
