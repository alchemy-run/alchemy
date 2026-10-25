import type * as webpubsub from "@distilled.cloud/azure/webpubsub-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Hub } from "./Hub.ts";

/**
 * A `ListConnectionsInGroup` request; the bound hub supplies the endpoint
 * and hub name, and the binding reads every page.
 */
export interface ListConnectionsInGroupRequest extends Omit<
  webpubsub.ListConnectionsInGroupRequest,
  "endpoint" | "hub" | "continuationToken" | "nextLink"
> {}

/** Runtime callable of {@link ListConnectionsInGroup}. */
export type ListConnectionsInGroupClient = (
  request: ListConnectionsInGroupRequest,
) => Effect.Effect<webpubsub.GroupMember[], webpubsub.ListConnectionsInGroupError, RuntimeContext>;

/**
 * List the connections (connection ID and user ID) in a group of an Azure
 * Web PubSub hub, from any host. The binding reads every page; `top` caps
 * the total and `maxpagesize` the page size.
 *
 * Binding assigns a custom role (`AzureWebPubSubGroupReadRole`, one per
 * stack) with exactly the data action `WebPubSub/group/read`, on the hub's
 * Web PubSub service (Web PubSub checks roles on the service, not on a
 * hub). The built-in **Web PubSub Service Reader** also grants the user and
 * connection reads. The service must allow Entra ID auth (`disableAadAuth`
 * unset, the default).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal and client secret (see
 * `AzureBindings`).
 * Provide {@link ListConnectionsInGroupHttp}.
 *
 * ### Calling ListConnectionsInGroup
 * **Example:** ListConnectionsInGroup from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: assigns AzureWebPubSubGroupReadRole on the hub's service
 *     const listConnectionsInGroup = yield* Azure.WebPubSub.ListConnectionsInGroup(chat);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the endpoint and hub name are filled in
 *         const members = yield* listConnectionsInGroup({ group: "room-1" });
 *         const users = members.map((m) => m.userId);
 *         return HttpServerResponse.json({ users });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.WebPubSub.ListConnectionsInGroupHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category WebPubSub
 */
export interface ListConnectionsInGroup extends Binding.Service<
  ListConnectionsInGroup,
  "Azure.WebPubSub.ListConnectionsInGroup",
  (hub: Hub) => Effect.Effect<ListConnectionsInGroupClient>
> {}

export const ListConnectionsInGroup = Binding.Service<ListConnectionsInGroup>(
  "Azure.WebPubSub.ListConnectionsInGroup",
);
