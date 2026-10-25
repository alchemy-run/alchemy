import type * as route from "@distilled.cloud/azure/maps-route";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

/** A `GetRouteRange` request; the bound account supplies `x-ms-client-id`. */
export interface GetRouteRangeRequest extends Omit<
  route.PostRouteRouteRangeRequest,
  "xMsClientId"
> {}

/** Runtime callable of {@link GetRouteRange}. */
export type GetRouteRangeClient = (
  request: GetRouteRangeRequest,
) => Effect.Effect<route.RouteRangeResponse, route.PostRouteRouteRangeError, RuntimeContext>;

/**
 * Compute the area reachable from a point within a time or distance budget (isochrone). Calls Azure Maps from any host with Microsoft Entra ID,
 * sending the bound account's unique ID as `x-ms-client-id`.
 *
 * Binding assigns a custom role (`AzureMapsRouteReadRole`, one per stack)
 * with exactly the data action `Microsoft.Maps/accounts/services/route/read`, on the
 * account only. The built-in **Azure Maps Data Reader** grants every Maps
 * service.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal and client secret (see
 * `AzureBindings`).
 * Provide {@link GetRouteRangeHttp}.
 *
 * ### Calling GetRouteRange
 * **Example:** GetRouteRange from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Azure.Maps.Account("maps");
 *     // init: assigns AzureMapsRouteReadRole on the account
 *     const getRouteRange = yield* Azure.Maps.GetRouteRange(account);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: x-ms-client-id is filled in
 *         const range = yield* getRouteRange({
 *   type: "Feature",
 *   geometry: { type: "Point", coordinates: [5.86605, 50.97452] },
 *   properties: { timeBudgetInSec: 600 },
 * });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Maps.GetRouteRangeHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Maps
 */
export interface GetRouteRange extends Binding.Service<
  GetRouteRange,
  "Azure.Maps.GetRouteRange",
  (account: Account) => Effect.Effect<GetRouteRangeClient>
> {}

export const GetRouteRange = Binding.Service<GetRouteRange>("Azure.Maps.GetRouteRange");
