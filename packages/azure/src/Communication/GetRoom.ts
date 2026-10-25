import type * as rooms from "@distilled.cloud/azure/communication-rooms";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface GetRoomRequest extends Omit<rooms.GetRoomRequest, "endpoint"> {}

/**
 * Read a room by ID.
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
 * Provide {@link GetRoomHttp}.
 *
 * ### Calling GetRoom
 * **Example:** GetRoom from a Function
 * ```typescript
 * // init
 * const getRoom = yield* Azure.Communication.GetRoom(acs);
 *
 * // runtime
 * const room = yield* getRoom({ roomId });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface GetRoom extends Binding.Service<
  GetRoom,
  "Azure.Communication.GetRoom",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (request: GetRoomRequest) => Effect.Effect<rooms.RoomModel, rooms.GetRoomError, RuntimeContext>
  >
> {}

export const GetRoom = Binding.Service<GetRoom>("Azure.Communication.GetRoom");
