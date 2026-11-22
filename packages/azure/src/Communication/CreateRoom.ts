import type * as rooms from "@distilled.cloud/azure/communication-rooms";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface CreateRoomRequest extends Omit<rooms.CreateRoomRequest, "endpoint"> {}

/**
 * Create a room: a server-managed space for scheduled calls with a fixed
 * participant list.
 *
 * Binding assigns a custom role (`AzureCommunicationDataRole`, one per stack)
 * with exactly the actions `Microsoft.Communication/CommunicationServices/Read`
 * and `/Write`, on the communication service only. The Communication
 * Services data plane has no data actions and denies Entra callers without
 * both, reads included.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link CreateRoomHttp}.
 *
 * ### Calling CreateRoom
 * **Example:** CreateRoom from a Function
 * ```typescript
 * // init
 * const createRoom = yield* Azure.Communication.CreateRoom(acs);
 *
 * // runtime
 * const room = yield* createRoom({
 *   validUntil: "2030-01-01T00:00:00Z",
 *   participants: { [`8:acs:${userId}`]: { role: "Presenter" } },
 * });
 * // room.id
 * ```
 *
 * @binding
 * @category Communication
 */
export interface CreateRoom extends Binding.Service<
  CreateRoom,
  "Azure.Communication.CreateRoom",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request?: CreateRoomRequest,
    ) => Effect.Effect<rooms.RoomModel, rooms.CreateRoomError, RuntimeContext>
  >
> {}

export const CreateRoom = Binding.Service<CreateRoom>("Azure.Communication.CreateRoom");
