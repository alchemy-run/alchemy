import type * as rooms from "@distilled.cloud/azure/communication-rooms";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface ListRoomsRequest extends Omit<rooms.ListRoomsRequest, "endpoint"> {}

/**
 * List the rooms of the communication service, one page per call (pass the
 * previous page's `nextLink` for the next).
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
 * Provide {@link ListRoomsHttp}.
 *
 * ### Calling ListRooms
 * **Example:** ListRooms from a Function
 * ```typescript
 * // init
 * const listRooms = yield* Azure.Communication.ListRooms(acs);
 *
 * // runtime
 * const page = yield* listRooms();
 * // page.value, page.nextLink
 * ```
 *
 * @binding
 * @category Communication
 */
export interface ListRooms extends Binding.Service<
  ListRooms,
  "Azure.Communication.ListRooms",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request?: ListRoomsRequest,
    ) => Effect.Effect<rooms.RoomsCollection, rooms.ListRoomsError, RuntimeContext>
  >
> {}

export const ListRooms = Binding.Service<ListRooms>("Azure.Communication.ListRooms");
