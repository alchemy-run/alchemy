import type * as webpubsub from "@distilled.cloud/azure/webpubsub-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Hub } from "./Hub.ts";

/** A `CheckPermission` request; the bound hub supplies the endpoint and hub name. */
export interface CheckPermissionRequest extends Omit<
  webpubsub.CheckPermissionRequest,
  "endpoint" | "hub"
> {}

/** Runtime callable of {@link CheckPermission}. */
export type CheckPermissionClient = (
  request: CheckPermissionRequest,
) => Effect.Effect<
  boolean,
  Exclude<webpubsub.CheckPermissionError, webpubsub.WebPubSubPermissionNotGranted>,
  RuntimeContext
>;

/**
 * Check whether a connection of an Azure Web PubSub hub holds a client
 * permission, from any host. Answers `false` when it does not.
 *
 * Binding assigns a custom role (`AzureWebPubSubConnectionReadRole`, one per stack)
 * with exactly the data action `WebPubSub/clientConnection/read`, on the hub's
 * Web PubSub service (Web PubSub checks roles on the service, not on a
 * hub). The built-in **Web PubSub Service Owner** grants every data action.
 * The service must allow Entra ID auth (`disableAadAuth` unset, the default).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal and client secret (see
 * `AzureBindings`).
 * Provide {@link CheckPermissionHttp}.
 *
 * ### Calling CheckPermission
 * **Example:** CheckPermission from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: assigns AzureWebPubSubConnectionReadRole on the hub's service
 *     const checkPermission = yield* Azure.WebPubSub.CheckPermission(chat);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the endpoint and hub name are filled in
 *         const canSend = yield* checkPermission({
 *           permission: "sendToGroup",
 *           connectionId,
 *           targetName: "room-1",
 *         });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.WebPubSub.CheckPermissionHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category WebPubSub
 */
export interface CheckPermission extends Binding.Service<
  CheckPermission,
  "Azure.WebPubSub.CheckPermission",
  (hub: Hub) => Effect.Effect<CheckPermissionClient>
> {}

export const CheckPermission = Binding.Service<CheckPermission>("Azure.WebPubSub.CheckPermission");
