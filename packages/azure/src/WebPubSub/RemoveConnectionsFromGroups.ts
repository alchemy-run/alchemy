import type * as webpubsub from "@distilled.cloud/azure/webpubsub-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Hub } from "./Hub.ts";

/** A `RemoveConnectionsFromGroups` request; the bound hub supplies the endpoint and hub name. */
export interface RemoveConnectionsFromGroupsRequest extends Omit<
  webpubsub.RemoveConnectionsFromGroupsRequest,
  "endpoint" | "hub"
> {}

/** Runtime callable of {@link RemoveConnectionsFromGroups}. */
export type RemoveConnectionsFromGroupsClient = (
  request: RemoveConnectionsFromGroupsRequest,
) => Effect.Effect<
  webpubsub.RemoveConnectionsFromGroupsResponse,
  webpubsub.RemoveConnectionsFromGroupsError,
  RuntimeContext
>;

/**
 * Remove the connections an OData `filter` selects from several groups of
 * an Azure Web PubSub hub, from any host.
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
 * Provide {@link RemoveConnectionsFromGroupsHttp}.
 *
 * ### Calling RemoveConnectionsFromGroups
 * **Example:** RemoveConnectionsFromGroups from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: assigns AzureWebPubSubGroupWriteRole on the hub's service
 *     const removeConnectionsFromGroups = yield* Azure.WebPubSub.RemoveConnectionsFromGroups(chat);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the endpoint and hub name are filled in
 *         yield* removeConnectionsFromGroups({
 *           groups: ["room-1", "room-2"],
 *           filter: "userId eq 'alice'",
 *         });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.WebPubSub.RemoveConnectionsFromGroupsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category WebPubSub
 */
export interface RemoveConnectionsFromGroups extends Binding.Service<
  RemoveConnectionsFromGroups,
  "Azure.WebPubSub.RemoveConnectionsFromGroups",
  (hub: Hub) => Effect.Effect<RemoveConnectionsFromGroupsClient>
> {}

export const RemoveConnectionsFromGroups = Binding.Service<RemoveConnectionsFromGroups>(
  "Azure.WebPubSub.RemoveConnectionsFromGroups",
);
