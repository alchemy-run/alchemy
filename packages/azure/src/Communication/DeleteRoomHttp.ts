import * as rooms from "@distilled.cloud/azure/communication-rooms";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { DeleteRoom } from "./DeleteRoom.ts";

/**
 * Implementation of {@link DeleteRoom} over the distilled `communication-rooms`
 * data plane. Assigns the custom `AzureCommunicationDataRole` on the
 * communication service.
 *
 * @layer
 * @provides Azure.Communication.DeleteRoom
 */
export const DeleteRoomHttp = Layer.effect(
  DeleteRoom,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.DeleteRoom",
    operation: rooms.DeleteRoom,
    grant: CommunicationRole.Data,
  }),
);
