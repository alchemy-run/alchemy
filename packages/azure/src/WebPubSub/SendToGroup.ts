import type * as webpubsub from "@distilled.cloud/azure/webpubsub-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Hub } from "./Hub.ts";

/** A `SendToGroup` request; the bound hub supplies the endpoint and hub name. */
export interface SendToGroupRequest extends Omit<
  webpubsub.SendToGroupRequest,
  "endpoint" | "hub"
> {}

/** Runtime callable of {@link SendToGroup}. */
export type SendToGroupClient = (
  request: SendToGroupRequest,
) => Effect.Effect<webpubsub.SendToGroupResponse, webpubsub.SendToGroupError, RuntimeContext>;

/**
 * Send a message to every connection in a group of an Azure Web PubSub
 * hub, from any host. `body` is sent as `text/plain` unless you set
 * `contentType`.
 *
 * Binding assigns a custom role (`AzureWebPubSubGroupSendRole`, one per stack)
 * with exactly the data action `WebPubSub/group/send/action`, on the hub's
 * Web PubSub service (Web PubSub checks roles on the service, not on a
 * hub). The built-in **Web PubSub Service Owner** grants every data action.
 * The service must allow Entra ID auth (`disableAadAuth` unset, the default).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal and client secret (see
 * `AzureBindings`).
 * Provide {@link SendToGroupHttp}.
 *
 * ### Calling SendToGroup
 * **Example:** SendToGroup from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: assigns AzureWebPubSubGroupSendRole on the hub's service
 *     const sendToGroup = yield* Azure.WebPubSub.SendToGroup(chat);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the endpoint and hub name are filled in
 *         yield* sendToGroup({
 *           group: "room-1",
 *           body: JSON.stringify({ text: "hi" }),
 *           contentType: "application/json",
 *         });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.WebPubSub.SendToGroupHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category WebPubSub
 */
export interface SendToGroup extends Binding.Service<
  SendToGroup,
  "Azure.WebPubSub.SendToGroup",
  (hub: Hub) => Effect.Effect<SendToGroupClient>
> {}

export const SendToGroup = Binding.Service<SendToGroup>("Azure.WebPubSub.SendToGroup");
