import type * as webpubsub from "@distilled.cloud/azure/webpubsub-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Hub } from "./Hub.ts";

/** A `GrantPermission` request; the bound hub supplies the endpoint and hub name. */
export interface GrantPermissionRequest extends Omit<
  webpubsub.GrantPermissionRequest,
  "endpoint" | "hub"
> {}

/** Runtime callable of {@link GrantPermission}. */
export type GrantPermissionClient = (
  request: GrantPermissionRequest,
) => Effect.Effect<
  webpubsub.GrantPermissionResponse,
  webpubsub.GrantPermissionError,
  RuntimeContext
>;

/**
 * Grant a connection of an Azure Web PubSub hub a client permission
 * (`sendToGroup` or `joinLeaveGroup`, optionally for one group), from any
 * host.
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
 * Provide {@link GrantPermissionHttp}.
 *
 * ### Calling GrantPermission
 * **Example:** GrantPermission from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: assigns AzureWebPubSubConnectionWriteRole on the hub's service
 *     const grantPermission = yield* Azure.WebPubSub.GrantPermission(chat);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the endpoint and hub name are filled in
 *         yield* grantPermission({ permission: "sendToGroup", connectionId, targetName: "room-1" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.WebPubSub.GrantPermissionHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category WebPubSub
 */
export interface GrantPermission extends Binding.Service<
  GrantPermission,
  "Azure.WebPubSub.GrantPermission",
  (hub: Hub) => Effect.Effect<GrantPermissionClient>
> {}

export const GrantPermission = Binding.Service<GrantPermission>("Azure.WebPubSub.GrantPermission");
