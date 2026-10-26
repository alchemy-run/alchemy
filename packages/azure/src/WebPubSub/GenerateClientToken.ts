import type * as webpubsub from "@distilled.cloud/azure/webpubsub-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Hub } from "./Hub.ts";

/** A `GenerateClientToken` request; the bound hub supplies the endpoint and hub name. */
export interface GenerateClientTokenRequest extends Omit<
  webpubsub.GenerateClientTokenRequest,
  "endpoint" | "hub"
> {}

/** Runtime callable of {@link GenerateClientToken}. */
export type GenerateClientTokenClient = (
  request?: GenerateClientTokenRequest,
) => Effect.Effect<
  webpubsub.ClientTokenResponse,
  webpubsub.GenerateClientTokenError,
  RuntimeContext
>;

/**
 * Mint a client access token for an Azure Web PubSub hub, from any host.
 * Clients connect to
 * `wss://{service}.webpubsub.azure.com/client/hubs/{hub}?access_token={token}`;
 * `role` (`webpubsub.sendToGroup`, `webpubsub.joinLeaveGroup`, …) and
 * `group` set what the connection may do and which groups it joins.
 *
 * The `token` comes back `Redacted`; read it with `Redacted.value` where
 * you build the client URL.
 *
 * Binding assigns a custom role (`AzureWebPubSubGenerateTokenRole`, one per stack)
 * with exactly the data action `WebPubSub/clientConnection/generateToken/action`, on the hub's
 * Web PubSub service (Web PubSub checks roles on the service, not on a
 * hub). The built-in **Web PubSub Service Owner** grants every data action.
 * The service must allow Entra ID auth (`disableAadAuth` unset, the default).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal and client secret (see
 * `AzureBindings`).
 * Provide {@link GenerateClientTokenHttp}.
 *
 * ### Calling GenerateClientToken
 * **Example:** GenerateClientToken from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: assigns AzureWebPubSubGenerateTokenRole on the hub's service
 *     const generateClientToken = yield* Azure.WebPubSub.GenerateClientToken(chat);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the endpoint and hub name are filled in
 *         const { token } = yield* generateClientToken({
 *           userId: "alice",
 *           role: ["webpubsub.joinLeaveGroup.room-1"],
 *           group: ["room-1"],
 *           minutesToExpire: 60,
 *         });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.WebPubSub.GenerateClientTokenHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category WebPubSub
 */
export interface GenerateClientToken extends Binding.Service<
  GenerateClientToken,
  "Azure.WebPubSub.GenerateClientToken",
  (hub: Hub) => Effect.Effect<GenerateClientTokenClient>
> {}

export const GenerateClientToken = Binding.Service<GenerateClientToken>(
  "Azure.WebPubSub.GenerateClientToken",
);
