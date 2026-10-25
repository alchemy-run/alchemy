import type * as webpubsub from "@distilled.cloud/azure/webpubsub-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Hub } from "./Hub.ts";

/** A `UserExists` request; the bound hub supplies the endpoint and hub name. */
export interface UserExistsRequest extends Omit<webpubsub.UserExistsRequest, "endpoint" | "hub"> {}

/** Runtime callable of {@link UserExists}. */
export type UserExistsClient = (
  request: UserExistsRequest,
) => Effect.Effect<
  boolean,
  Exclude<webpubsub.UserExistsError, webpubsub.WebPubSubUserNotFound>,
  RuntimeContext
>;

/**
 * Check whether a user has any connection to an Azure Web PubSub hub, from
 * any host. Answers `false` when the user has none.
 *
 * Binding assigns a custom role (`AzureWebPubSubUserReadRole`, one per stack)
 * with exactly the data action `WebPubSub/user/read`, on the hub's
 * Web PubSub service (Web PubSub checks roles on the service, not on a
 * hub). The built-in **Web PubSub Service Owner** grants every data action.
 * The service must allow Entra ID auth (`disableAadAuth` unset, the default).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal and client secret (see
 * `AzureBindings`).
 * Provide {@link UserExistsHttp}.
 *
 * ### Calling UserExists
 * **Example:** UserExists from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: assigns AzureWebPubSubUserReadRole on the hub's service
 *     const userExists = yield* Azure.WebPubSub.UserExists(chat);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the endpoint and hub name are filled in
 *         const online = yield* userExists({ userId: "alice" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.WebPubSub.UserExistsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category WebPubSub
 */
export interface UserExists extends Binding.Service<
  UserExists,
  "Azure.WebPubSub.UserExists",
  (hub: Hub) => Effect.Effect<UserExistsClient>
> {}

export const UserExists = Binding.Service<UserExists>("Azure.WebPubSub.UserExists");
