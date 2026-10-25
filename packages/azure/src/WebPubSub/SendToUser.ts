import type * as webpubsub from "@distilled.cloud/azure/webpubsub-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Hub } from "./Hub.ts";

/** A `SendToUser` request; the bound hub supplies the endpoint and hub name. */
export interface SendToUserRequest extends Omit<webpubsub.SendToUserRequest, "endpoint" | "hub"> {}

/** Runtime callable of {@link SendToUser}. */
export type SendToUserClient = (
  request: SendToUserRequest,
) => Effect.Effect<webpubsub.SendToUserResponse, webpubsub.SendToUserError, RuntimeContext>;

/**
 * Send a message to every connection of one user of an Azure Web PubSub
 * hub, from any host. `body` is sent as `text/plain` unless you set
 * `contentType`.
 *
 * Binding assigns a custom role (`AzureWebPubSubUserSendRole`, one per stack)
 * with exactly the data action `WebPubSub/user/send/action`, on the hub's
 * Web PubSub service (Web PubSub checks roles on the service, not on a
 * hub). The built-in **Web PubSub Service Owner** grants every data action.
 * The service must allow Entra ID auth (`disableAadAuth` unset, the default).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal and client secret (see
 * `AzureBindings`).
 * Provide {@link SendToUserHttp}.
 *
 * ### Calling SendToUser
 * **Example:** SendToUser from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: assigns AzureWebPubSubUserSendRole on the hub's service
 *     const sendToUser = yield* Azure.WebPubSub.SendToUser(chat);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the endpoint and hub name are filled in
 *         yield* sendToUser({ userId: "alice", body: "you have mail" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.WebPubSub.SendToUserHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category WebPubSub
 */
export interface SendToUser extends Binding.Service<
  SendToUser,
  "Azure.WebPubSub.SendToUser",
  (hub: Hub) => Effect.Effect<SendToUserClient>
> {}

export const SendToUser = Binding.Service<SendToUser>("Azure.WebPubSub.SendToUser");
