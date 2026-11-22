import * as rooms from "@distilled.cloud/azure/communication-rooms";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { ListRooms } from "./ListRooms.ts";

/**
 * Implementation of {@link ListRooms} over the distilled `communication-rooms`
 * data plane. Assigns the custom `AzureCommunicationDataRole` on the
 * communication service.
 *
 * @layer
 * @provides Azure.Communication.ListRooms
 */
export const ListRoomsHttp = Layer.effect(
  ListRooms,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.ListRooms",
    operation: rooms.ListRooms,
    grant: CommunicationRole.Data,
  }),
);
