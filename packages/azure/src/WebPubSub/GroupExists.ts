import type * as webpubsub from "@distilled.cloud/azure/webpubsub-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Hub } from "./Hub.ts";

/** A `GroupExists` request; the bound hub supplies the endpoint and hub name. */
export interface GroupExistsRequest extends Omit<
  webpubsub.GroupExistsRequest,
  "endpoint" | "hub"
> {}

/** Runtime callable of {@link GroupExists}. */
export type GroupExistsClient = (
  request: GroupExistsRequest,
) => Effect.Effect<
  boolean,
  Exclude<webpubsub.GroupExistsError, webpubsub.WebPubSubGroupNotFound>,
  RuntimeContext
>;

/**
 * Check whether a group of an Azure Web PubSub hub has any connection,
 * from any host. Answers `false` for an empty group.
 *
 * Binding assigns a custom role (`AzureWebPubSubGroupReadRole`, one per stack)
 * with exactly the data action `WebPubSub/group/read`, on the hub's
 * Web PubSub service (Web PubSub checks roles on the service, not on a
 * hub). The built-in **Web PubSub Service Owner** grants every data action.
 * The service must allow Entra ID auth (`disableAadAuth` unset, the default).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal and client secret (see
 * `AzureBindings`).
 * Provide {@link GroupExistsHttp}.
 *
 * ### Calling GroupExists
 * **Example:** GroupExists from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: assigns AzureWebPubSubGroupReadRole on the hub's service
 *     const groupExists = yield* Azure.WebPubSub.GroupExists(chat);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the endpoint and hub name are filled in
 *         const active = yield* groupExists({ group: "room-1" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.WebPubSub.GroupExistsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category WebPubSub
 */
export interface GroupExists extends Binding.Service<
  GroupExists,
  "Azure.WebPubSub.GroupExists",
  (hub: Hub) => Effect.Effect<GroupExistsClient>
> {}

export const GroupExists = Binding.Service<GroupExists>("Azure.WebPubSub.GroupExists");
