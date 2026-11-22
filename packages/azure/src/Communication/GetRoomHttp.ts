import * as rooms from "@distilled.cloud/azure/communication-rooms";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { GetRoom } from "./GetRoom.ts";

/**
 * Implementation of {@link GetRoom} over the distilled `communication-rooms`
 * data plane. Assigns the custom `AzureCommunicationDataRole` on the
 * communication service.
 *
 * @layer
 * @provides Azure.Communication.GetRoom
 */
export const GetRoomHttp = Layer.effect(
  GetRoom,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.GetRoom",
    operation: rooms.GetRoom,
    grant: CommunicationRole.Data,
  }),
);
