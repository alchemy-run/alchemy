import * as rooms from "@distilled.cloud/azure/communication-rooms";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { UpdateRoom } from "./UpdateRoom.ts";

/**
 * Implementation of {@link UpdateRoom} over the distilled `communication-rooms`
 * data plane. Assigns the custom `AzureCommunicationDataRole` on the
 * communication service.
 *
 * @layer
 * @provides Azure.Communication.UpdateRoom
 */
export const UpdateRoomHttp = Layer.effect(
  UpdateRoom,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.UpdateRoom",
    operation: rooms.UpdateRoom,
    grant: CommunicationRole.Data,
  }),
);
