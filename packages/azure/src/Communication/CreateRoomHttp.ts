import * as rooms from "@distilled.cloud/azure/communication-rooms";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { CreateRoom } from "./CreateRoom.ts";

/**
 * Implementation of {@link CreateRoom} over the distilled `communication-rooms`
 * data plane. Assigns the custom `AzureCommunicationDataRole` on the
 * communication service.
 *
 * @layer
 * @provides Azure.Communication.CreateRoom
 */
export const CreateRoomHttp = Layer.effect(
  CreateRoom,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.CreateRoom",
    operation: rooms.CreateRoom,
    grant: CommunicationRole.Data,
  }),
);
