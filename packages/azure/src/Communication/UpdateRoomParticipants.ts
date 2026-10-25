import type * as rooms from "@distilled.cloud/azure/communication-rooms";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface UpdateRoomParticipantsRequest extends Omit<
  rooms.UpdateParticipantRequest,
  "endpoint"
> {}

/**
 * Add, change, or remove room participants (a `null` role removes one).
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
 * Provide {@link UpdateRoomParticipantsHttp}.
 *
 * ### Calling UpdateRoomParticipants
 * **Example:** UpdateRoomParticipants from a Function
 * ```typescript
 * // init
 * const updateRoomParticipants = yield* Azure.Communication.UpdateRoomParticipants(acs);
 *
 * // runtime
 * yield* updateRoomParticipants({
 *   roomId,
 *   participants: { [`8:acs:${userId}`]: { role: "Attendee" } },
 * });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface UpdateRoomParticipants extends Binding.Service<
  UpdateRoomParticipants,
  "Azure.Communication.UpdateRoomParticipants",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: UpdateRoomParticipantsRequest,
    ) => Effect.Effect<
      rooms.UpdateParticipantResponse,
      rooms.UpdateParticipantError,
      RuntimeContext
    >
  >
> {}

export const UpdateRoomParticipants = Binding.Service<UpdateRoomParticipants>(
  "Azure.Communication.UpdateRoomParticipants",
);
