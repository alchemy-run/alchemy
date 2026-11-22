import type * as search from "@distilled.cloud/azure/maps-search";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

/** A `GetPolygon` request; the bound account supplies `x-ms-client-id`. */
export interface GetPolygonRequest extends Omit<search.SearchGetPolygonRequest, "xMsClientId"> {}

/** Runtime callable of {@link GetPolygon}. */
export type GetPolygonClient = (
  request: GetPolygonRequest,
) => Effect.Effect<search.Boundary, search.SearchGetPolygonError, RuntimeContext>;

/**
 * Get the boundary polygon of the place at a coordinate (a city, postcode, country/region). Calls Azure Maps from any host with Microsoft Entra ID,
 * sending the bound account's unique ID as `x-ms-client-id`.
 *
 * Binding assigns a custom role (`AzureMapsSearchReadRole`, one per stack)
 * with exactly the data action `Microsoft.Maps/accounts/services/search/read`, on the
 * account only. The built-in **Azure Maps Data Reader** grants every Maps
 * service.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal and client secret (see
 * `AzureBindings`).
 * Provide {@link GetPolygonHttp}.
 *
 * ### Calling GetPolygon
 * **Example:** GetPolygon from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Azure.Maps.Account("maps");
 *     // init: assigns AzureMapsSearchReadRole on the account
 *     const getPolygon = yield* Azure.Maps.GetPolygon(account);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: x-ms-client-id is filled in
 *         const boundary = yield* getPolygon({ coordinates: "-122.204141,47.61256", resultType: "locality", resolution: "small" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Maps.GetPolygonHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Maps
 */
export interface GetPolygon extends Binding.Service<
  GetPolygon,
  "Azure.Maps.GetPolygon",
  (account: Account) => Effect.Effect<GetPolygonClient>
> {}

export const GetPolygon = Binding.Service<GetPolygon>("Azure.Maps.GetPolygon");
