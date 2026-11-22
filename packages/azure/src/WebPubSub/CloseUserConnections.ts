import type * as webpubsub from "@distilled.cloud/azure/webpubsub-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Hub } from "./Hub.ts";

/** A `CloseUserConnections` request; the bound hub supplies the endpoint and hub name. */
export interface CloseUserConnectionsRequest extends Omit<
  webpubsub.CloseUserConnectionsRequest,
  "endpoint" | "hub"
> {}

/** Runtime callable of {@link CloseUserConnections}. */
export type CloseUserConnectionsClient = (
  request: CloseUserConnectionsRequest,
) => Effect.Effect<
  webpubsub.CloseUserConnectionsResponse,
  webpubsub.CloseUserConnectionsError,
  RuntimeContext
>;

/**
 * Close every connection of one user of an Azure Web PubSub hub, from any
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
 * Provide {@link CloseUserConnectionsHttp}.
 *
 * ### Calling CloseUserConnections
 * **Example:** CloseUserConnections from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: assigns AzureWebPubSubConnectionWriteRole on the hub's service
 *     const closeUserConnections = yield* Azure.WebPubSub.CloseUserConnections(chat);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the endpoint and hub name are filled in
 *         yield* closeUserConnections({ userId: "alice", reason: "account disabled" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.WebPubSub.CloseUserConnectionsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category WebPubSub
 */
export interface CloseUserConnections extends Binding.Service<
  CloseUserConnections,
  "Azure.WebPubSub.CloseUserConnections",
  (hub: Hub) => Effect.Effect<CloseUserConnectionsClient>
> {}

export const CloseUserConnections = Binding.Service<CloseUserConnections>(
  "Azure.WebPubSub.CloseUserConnections",
);
