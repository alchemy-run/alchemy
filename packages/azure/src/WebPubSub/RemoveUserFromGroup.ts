import type * as webpubsub from "@distilled.cloud/azure/webpubsub-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Hub } from "./Hub.ts";

/** A `RemoveUserFromGroup` request; the bound hub supplies the endpoint and hub name. */
export interface RemoveUserFromGroupRequest extends Omit<
  webpubsub.RemoveUserFromGroupRequest,
  "endpoint" | "hub"
> {}

/** Runtime callable of {@link RemoveUserFromGroup}. */
export type RemoveUserFromGroupClient = (
  request: RemoveUserFromGroupRequest,
) => Effect.Effect<
  webpubsub.RemoveUserFromGroupResponse,
  webpubsub.RemoveUserFromGroupError,
  RuntimeContext
>;

/**
 * Remove every connection of one user from a group of an Azure Web PubSub
 * hub, from any host.
 *
 * Binding assigns a custom role (`AzureWebPubSubGroupWriteRole`, one per stack)
 * with exactly the data action `WebPubSub/group/write`, on the hub's
 * Web PubSub service (Web PubSub checks roles on the service, not on a
 * hub). The built-in **Web PubSub Service Owner** grants every data action.
 * The service must allow Entra ID auth (`disableAadAuth` unset, the default).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal and client secret (see
 * `AzureBindings`).
 * Provide {@link RemoveUserFromGroupHttp}.
 *
 * ### Calling RemoveUserFromGroup
 * **Example:** RemoveUserFromGroup from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: assigns AzureWebPubSubGroupWriteRole on the hub's service
 *     const removeUserFromGroup = yield* Azure.WebPubSub.RemoveUserFromGroup(chat);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the endpoint and hub name are filled in
 *         yield* removeUserFromGroup({ userId: "alice", group: "room-1" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.WebPubSub.RemoveUserFromGroupHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category WebPubSub
 */
export interface RemoveUserFromGroup extends Binding.Service<
  RemoveUserFromGroup,
  "Azure.WebPubSub.RemoveUserFromGroup",
  (hub: Hub) => Effect.Effect<RemoveUserFromGroupClient>
> {}

export const RemoveUserFromGroup = Binding.Service<RemoveUserFromGroup>(
  "Azure.WebPubSub.RemoveUserFromGroup",
);
