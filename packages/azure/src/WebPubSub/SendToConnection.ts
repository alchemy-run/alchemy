import type * as webpubsub from "@distilled.cloud/azure/webpubsub-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Hub } from "./Hub.ts";

/** A `SendToConnection` request; the bound hub supplies the endpoint and hub name. */
export interface SendToConnectionRequest extends Omit<
  webpubsub.SendToConnectionRequest,
  "endpoint" | "hub"
> {}

/** Runtime callable of {@link SendToConnection}. */
export type SendToConnectionClient = (
  request: SendToConnectionRequest,
) => Effect.Effect<
  webpubsub.SendToConnectionResponse,
  webpubsub.SendToConnectionError,
  RuntimeContext
>;

/**
 * Send a message to one client connection of an Azure Web PubSub hub,
 * from any host. `body` is sent as `text/plain` unless you set
 * `contentType`.
 *
 * Binding assigns a custom role (`AzureWebPubSubConnectionSendRole`, one per stack)
 * with exactly the data action `WebPubSub/clientConnection/send/action`, on the hub's
 * Web PubSub service (Web PubSub checks roles on the service, not on a
 * hub). The built-in **Web PubSub Service Owner** grants every data action.
 * The service must allow Entra ID auth (`disableAadAuth` unset, the default).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal and client secret (see
 * `AzureBindings`).
 * Provide {@link SendToConnectionHttp}.
 *
 * ### Calling SendToConnection
 * **Example:** SendToConnection from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: assigns AzureWebPubSubConnectionSendRole on the hub's service
 *     const sendToConnection = yield* Azure.WebPubSub.SendToConnection(chat);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the endpoint and hub name are filled in
 *         yield* sendToConnection({ connectionId, body: "welcome" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.WebPubSub.SendToConnectionHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category WebPubSub
 */
export interface SendToConnection extends Binding.Service<
  SendToConnection,
  "Azure.WebPubSub.SendToConnection",
  (hub: Hub) => Effect.Effect<SendToConnectionClient>
> {}

export const SendToConnection = Binding.Service<SendToConnection>(
  "Azure.WebPubSub.SendToConnection",
);
