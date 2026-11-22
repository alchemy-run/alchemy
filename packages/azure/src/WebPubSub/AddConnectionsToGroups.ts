import type * as webpubsub from "@distilled.cloud/azure/webpubsub-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Hub } from "./Hub.ts";

/** A `AddConnectionsToGroups` request; the bound hub supplies the endpoint and hub name. */
export interface AddConnectionsToGroupsRequest extends Omit<
  webpubsub.AddConnectionsToGroupsRequest,
  "endpoint" | "hub"
> {}

/** Runtime callable of {@link AddConnectionsToGroups}. */
export type AddConnectionsToGroupsClient = (
  request: AddConnectionsToGroupsRequest,
) => Effect.Effect<
  webpubsub.AddConnectionsToGroupsResponse,
  webpubsub.AddConnectionsToGroupsError,
  RuntimeContext
>;

/**
 * Add the connections an OData `filter` selects to several groups of an
 * Azure Web PubSub hub, from any host.
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
 * Provide {@link AddConnectionsToGroupsHttp}.
 *
 * ### Calling AddConnectionsToGroups
 * **Example:** AddConnectionsToGroups from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: assigns AzureWebPubSubGroupWriteRole on the hub's service
 *     const addConnectionsToGroups = yield* Azure.WebPubSub.AddConnectionsToGroups(chat);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the endpoint and hub name are filled in
 *         yield* addConnectionsToGroups({
 *           groups: ["room-1", "room-2"],
 *           filter: "userId eq 'alice'",
 *         });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.WebPubSub.AddConnectionsToGroupsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category WebPubSub
 */
export interface AddConnectionsToGroups extends Binding.Service<
  AddConnectionsToGroups,
  "Azure.WebPubSub.AddConnectionsToGroups",
  (hub: Hub) => Effect.Effect<AddConnectionsToGroupsClient>
> {}

export const AddConnectionsToGroups = Binding.Service<AddConnectionsToGroups>(
  "Azure.WebPubSub.AddConnectionsToGroups",
);
