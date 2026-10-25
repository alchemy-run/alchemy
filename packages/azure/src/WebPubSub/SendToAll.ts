import type * as webpubsub from "@distilled.cloud/azure/webpubsub-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Hub } from "./Hub.ts";

/** A `SendToAll` request; the bound hub supplies the endpoint and hub name. */
export interface SendToAllRequest extends Omit<webpubsub.SendToAllRequest, "endpoint" | "hub"> {}

/** Runtime callable of {@link SendToAll}. */
export type SendToAllClient = (
  request: SendToAllRequest,
) => Effect.Effect<webpubsub.SendToAllResponse, webpubsub.SendToAllError, RuntimeContext>;

/**
 * Broadcast a message to every client connected to an Azure Web PubSub
 * hub, from any host. `body` is sent as `text/plain` unless you set
 * `contentType` (`application/json`, `application/octet-stream`).
 *
 * Binding assigns a custom role (`AzureWebPubSubHubSendRole`, one per stack)
 * with exactly the data action `WebPubSub/hub/send/action`, on the hub's
 * Web PubSub service (Web PubSub checks roles on the service, not on a
 * hub). The built-in **Web PubSub Service Owner** grants every data action.
 * The service must allow Entra ID auth (`disableAadAuth` unset, the default).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal and client secret (see
 * `AzureBindings`).
 * Provide {@link SendToAllHttp}.
 *
 * ### Calling SendToAll
 * **Example:** SendToAll from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: assigns AzureWebPubSubHubSendRole on the hub's service
 *     const sendToAll = yield* Azure.WebPubSub.SendToAll(chat);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the endpoint and hub name are filled in
 *         yield* sendToAll({ body: "hello everyone" });
 *         yield* sendToAll({
 *           body: JSON.stringify({ kind: "notice" }),
 *           contentType: "application/json",
 *           excluded: [senderConnectionId],
 *         });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.WebPubSub.SendToAllHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category WebPubSub
 */
export interface SendToAll extends Binding.Service<
  SendToAll,
  "Azure.WebPubSub.SendToAll",
  (hub: Hub) => Effect.Effect<SendToAllClient>
> {}

export const SendToAll = Binding.Service<SendToAll>("Azure.WebPubSub.SendToAll");
