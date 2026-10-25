import type * as rooms from "@distilled.cloud/azure/communication-rooms";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface DeleteRoomRequest extends Omit<rooms.DeleteRoomRequest, "endpoint"> {}

/**
 * Delete a room.
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
 * Provide {@link DeleteRoomHttp}.
 *
 * ### Calling DeleteRoom
 * **Example:** DeleteRoom from a Function
 * ```typescript
 * // init
 * const deleteRoom = yield* Azure.Communication.DeleteRoom(acs);
 *
 * // runtime
 * yield* deleteRoom({ roomId });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface DeleteRoom extends Binding.Service<
  DeleteRoom,
  "Azure.Communication.DeleteRoom",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: DeleteRoomRequest,
    ) => Effect.Effect<rooms.DeleteRoomResponse, rooms.DeleteRoomError, RuntimeContext>
  >
> {}

export const DeleteRoom = Binding.Service<DeleteRoom>("Azure.Communication.DeleteRoom");
