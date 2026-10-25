import * as rooms from "@distilled.cloud/azure/communication-rooms";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { ListRoomParticipants } from "./ListRoomParticipants.ts";

/**
 * Implementation of {@link ListRoomParticipants} over the distilled `communication-rooms`
 * data plane. Assigns the custom `AzureCommunicationDataRole` on the
 * communication service.
 *
 * @layer
 * @provides Azure.Communication.ListRoomParticipants
 */
export const ListRoomParticipantsHttp = Layer.effect(
  ListRoomParticipants,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.ListRoomParticipants",
    operation: rooms.ListParticipants,
    grant: CommunicationRole.Data,
  }),
);
