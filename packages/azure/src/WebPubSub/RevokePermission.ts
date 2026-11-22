import type * as webpubsub from "@distilled.cloud/azure/webpubsub-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Hub } from "./Hub.ts";

/** A `RevokePermission` request; the bound hub supplies the endpoint and hub name. */
export interface RevokePermissionRequest extends Omit<
  webpubsub.RevokePermissionRequest,
  "endpoint" | "hub"
> {}

/** Runtime callable of {@link RevokePermission}. */
export type RevokePermissionClient = (
  request: RevokePermissionRequest,
) => Effect.Effect<
  webpubsub.RevokePermissionResponse,
  webpubsub.RevokePermissionError,
  RuntimeContext
>;

/**
 * Revoke a client permission (`sendToGroup` or `joinLeaveGroup`) from a
 * connection of an Azure Web PubSub hub, from any host.
 *
 * Binding assigns a custom role (`AzureWebPubSubConnectionWriteRole`, one per stack)
 * with exactly the data action `WebPubSub/clientConnection/write`, on the hub's
 * Web PubSub service (Web PubSub checks roles on the service, not on a
 * hub). The built-in **Web PubSub Service Owner** grants every data action.
 * The service must allow Entra ID auth (`disableAadAuth` unset, the default).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal and client secret (see
 * `AzureBindings`).
 * Provide {@link RevokePermissionHttp}.
 *
 * ### Calling RevokePermission
 * **Example:** RevokePermission from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: assigns AzureWebPubSubConnectionWriteRole on the hub's service
 *     const revokePermission = yield* Azure.WebPubSub.RevokePermission(chat);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the endpoint and hub name are filled in
 *         yield* revokePermission({ permission: "sendToGroup", connectionId, targetName: "room-1" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.WebPubSub.RevokePermissionHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category WebPubSub
 */
export interface RevokePermission extends Binding.Service<
  RevokePermission,
  "Azure.WebPubSub.RevokePermission",
  (hub: Hub) => Effect.Effect<RevokePermissionClient>
> {}

export const RevokePermission = Binding.Service<RevokePermission>(
  "Azure.WebPubSub.RevokePermission",
);
