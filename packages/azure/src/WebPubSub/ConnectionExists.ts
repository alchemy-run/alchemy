import type * as webpubsub from "@distilled.cloud/azure/webpubsub-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Hub } from "./Hub.ts";

/** A `ConnectionExists` request; the bound hub supplies the endpoint and hub name. */
export interface ConnectionExistsRequest extends Omit<
  webpubsub.ConnectionExistsRequest,
  "endpoint" | "hub"
> {}

/** Runtime callable of {@link ConnectionExists}. */
export type ConnectionExistsClient = (
  request: ConnectionExistsRequest,
) => Effect.Effect<
  boolean,
  Exclude<webpubsub.ConnectionExistsError, webpubsub.WebPubSubConnectionNotFound>,
  RuntimeContext
>;

/**
 * Check whether a client connection is open in an Azure Web PubSub hub,
 * from any host. Answers `false` for a connection that does not exist.
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
 * Provide {@link ConnectionExistsHttp}.
 *
 * ### Calling ConnectionExists
 * **Example:** ConnectionExists from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: assigns AzureWebPubSubConnectionReadRole on the hub's service
 *     const connectionExists = yield* Azure.WebPubSub.ConnectionExists(chat);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the endpoint and hub name are filled in
 *         const open = yield* connectionExists({ connectionId });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.WebPubSub.ConnectionExistsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category WebPubSub
 */
export interface ConnectionExists extends Binding.Service<
  ConnectionExists,
  "Azure.WebPubSub.ConnectionExists",
  (hub: Hub) => Effect.Effect<ConnectionExistsClient>
> {}

export const ConnectionExists = Binding.Service<ConnectionExists>(
  "Azure.WebPubSub.ConnectionExists",
);
