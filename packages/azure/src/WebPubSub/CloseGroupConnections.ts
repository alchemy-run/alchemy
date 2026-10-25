import type * as webpubsub from "@distilled.cloud/azure/webpubsub-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Hub } from "./Hub.ts";

/** A `CloseGroupConnections` request; the bound hub supplies the endpoint and hub name. */
export interface CloseGroupConnectionsRequest extends Omit<
  webpubsub.CloseGroupConnectionsRequest,
  "endpoint" | "hub"
> {}

/** Runtime callable of {@link CloseGroupConnections}. */
export type CloseGroupConnectionsClient = (
  request: CloseGroupConnectionsRequest,
) => Effect.Effect<
  webpubsub.CloseGroupConnectionsResponse,
  webpubsub.CloseGroupConnectionsError,
  RuntimeContext
>;

/**
 * Close every connection in a group of an Azure Web PubSub hub, from any
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
 * Provide {@link CloseGroupConnectionsHttp}.
 *
 * ### Calling CloseGroupConnections
 * **Example:** CloseGroupConnections from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: assigns AzureWebPubSubConnectionWriteRole on the hub's service
 *     const closeGroupConnections = yield* Azure.WebPubSub.CloseGroupConnections(chat);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the endpoint and hub name are filled in
 *         yield* closeGroupConnections({ group: "room-1", reason: "room closed" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.WebPubSub.CloseGroupConnectionsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category WebPubSub
 */
export interface CloseGroupConnections extends Binding.Service<
  CloseGroupConnections,
  "Azure.WebPubSub.CloseGroupConnections",
  (hub: Hub) => Effect.Effect<CloseGroupConnectionsClient>
> {}

export const CloseGroupConnections = Binding.Service<CloseGroupConnections>(
  "Azure.WebPubSub.CloseGroupConnections",
);
