import type * as webpubsub from "@distilled.cloud/azure/webpubsub-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Hub } from "./Hub.ts";

/** A `RemoveUserFromAllGroups` request; the bound hub supplies the endpoint and hub name. */
export interface RemoveUserFromAllGroupsRequest extends Omit<
  webpubsub.RemoveUserFromAllGroupsRequest,
  "endpoint" | "hub"
> {}

/** Runtime callable of {@link RemoveUserFromAllGroups}. */
export type RemoveUserFromAllGroupsClient = (
  request: RemoveUserFromAllGroupsRequest,
) => Effect.Effect<
  webpubsub.RemoveUserFromAllGroupsResponse,
  webpubsub.RemoveUserFromAllGroupsError,
  RuntimeContext
>;

/**
 * Remove every connection of one user from every group of an Azure Web
 * PubSub hub, from any host.
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
 * Provide {@link RemoveUserFromAllGroupsHttp}.
 *
 * ### Calling RemoveUserFromAllGroups
 * **Example:** RemoveUserFromAllGroups from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: assigns AzureWebPubSubGroupWriteRole on the hub's service
 *     const removeUserFromAllGroups = yield* Azure.WebPubSub.RemoveUserFromAllGroups(chat);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the endpoint and hub name are filled in
 *         yield* removeUserFromAllGroups({ userId: "alice" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.WebPubSub.RemoveUserFromAllGroupsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category WebPubSub
 */
export interface RemoveUserFromAllGroups extends Binding.Service<
  RemoveUserFromAllGroups,
  "Azure.WebPubSub.RemoveUserFromAllGroups",
  (hub: Hub) => Effect.Effect<RemoveUserFromAllGroupsClient>
> {}

export const RemoveUserFromAllGroups = Binding.Service<RemoveUserFromAllGroups>(
  "Azure.WebPubSub.RemoveUserFromAllGroups",
);
