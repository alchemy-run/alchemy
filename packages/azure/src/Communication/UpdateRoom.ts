import type * as rooms from "@distilled.cloud/azure/communication-rooms";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface UpdateRoomRequest extends Omit<rooms.UpdateRoomRequest, "endpoint"> {}

/**
 * Change a room's validity window or PSTN dial-out setting.
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
 * Provide {@link UpdateRoomHttp}.
 *
 * ### Calling UpdateRoom
 * **Example:** UpdateRoom from a Function
 * ```typescript
 * // init
 * const updateRoom = yield* Azure.Communication.UpdateRoom(acs);
 *
 * // runtime
 * const room = yield* updateRoom({ roomId, pstnDialOutEnabled: true });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface UpdateRoom extends Binding.Service<
  UpdateRoom,
  "Azure.Communication.UpdateRoom",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: UpdateRoomRequest,
    ) => Effect.Effect<rooms.RoomModel, rooms.UpdateRoomError, RuntimeContext>
  >
> {}

export const UpdateRoom = Binding.Service<UpdateRoom>("Azure.Communication.UpdateRoom");
