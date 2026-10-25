import type * as rooms from "@distilled.cloud/azure/communication-rooms";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface ListRoomParticipantsRequest extends Omit<
  rooms.ListParticipantsRequest,
  "endpoint"
> {}

/**
 * List the participants of a room, one page per call.
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
 * Provide {@link ListRoomParticipantsHttp}.
 *
 * ### Calling ListRoomParticipants
 * **Example:** ListRoomParticipants from a Function
 * ```typescript
 * // init
 * const listRoomParticipants = yield* Azure.Communication.ListRoomParticipants(acs);
 *
 * // runtime
 * const page = yield* listRoomParticipants({ roomId });
 * // page.value[0].rawId, page.value[0].role
 * ```
 *
 * @binding
 * @category Communication
 */
export interface ListRoomParticipants extends Binding.Service<
  ListRoomParticipants,
  "Azure.Communication.ListRoomParticipants",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: ListRoomParticipantsRequest,
    ) => Effect.Effect<rooms.ParticipantsCollection, rooms.ListParticipantsError, RuntimeContext>
  >
> {}

export const ListRoomParticipants = Binding.Service<ListRoomParticipants>(
  "Azure.Communication.ListRoomParticipants",
);
