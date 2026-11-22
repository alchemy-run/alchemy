import type * as render from "@distilled.cloud/azure/maps-render";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

/** A `GetMapAttribution` request; the bound account supplies `x-ms-client-id`. */
export interface GetMapAttributionRequest extends Omit<
  render.GetRenderMapAttributionRequest,
  "xMsClientId"
> {}

/** Runtime callable of {@link GetMapAttribution}. */
export type GetMapAttributionClient = (
  request: GetMapAttributionRequest,
) => Effect.Effect<render.MapAttribution, render.GetRenderMapAttributionError, RuntimeContext>;

/**
 * Get the copyright attribution for a tileset in an area at a zoom level. Calls Azure Maps from any host with Microsoft Entra ID,
 * sending the bound account's unique ID as `x-ms-client-id`.
 *
 * Binding assigns a custom role (`AzureMapsRenderReadRole`, one per stack)
 * with exactly the data action `Microsoft.Maps/accounts/services/render/read`, on the
 * account only. The built-in **Azure Maps Data Reader** grants every Maps
 * service.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal and client secret (see
 * `AzureBindings`).
 * Provide {@link GetMapAttributionHttp}.
 *
 * ### Calling GetMapAttribution
 * **Example:** GetMapAttribution from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Azure.Maps.Account("maps");
 *     // init: assigns AzureMapsRenderReadRole on the account
 *     const getMapAttribution = yield* Azure.Maps.GetMapAttribution(account);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: x-ms-client-id is filled in
 *         const { copyrights } = yield* getMapAttribution({
 *   tilesetId: "microsoft.base",
 *   zoom: 6,
 *   bounds: "-122.414162,47.57949,-122.247157,47.668372",
 * });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Maps.GetMapAttributionHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Maps
 */
export interface GetMapAttribution extends Binding.Service<
  GetMapAttribution,
  "Azure.Maps.GetMapAttribution",
  (account: Account) => Effect.Effect<GetMapAttributionClient>
> {}

export const GetMapAttribution = Binding.Service<GetMapAttribution>("Azure.Maps.GetMapAttribution");
