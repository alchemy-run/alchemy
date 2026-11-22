import type * as route from "@distilled.cloud/azure/maps-route";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

/** A `GetRouteDirections` request; the bound account supplies `x-ms-client-id`. */
export interface GetRouteDirectionsRequest extends Omit<
  route.PostRouteRouteDirectionsRequest,
  "xMsClientId"
> {}

/** Runtime callable of {@link GetRouteDirections}. */
export type GetRouteDirectionsClient = (
  request: GetRouteDirectionsRequest,
) => Effect.Effect<
  route.PostRouteRouteDirectionsResponse,
  route.PostRouteRouteDirectionsError,
  RuntimeContext
>;

/**
 * Compute a route between waypoints (GeoJSON in, GeoJSON out). Calls Azure Maps from any host with Microsoft Entra ID,
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
 * Provide {@link GetRouteDirectionsHttp}.
 *
 * ### Calling GetRouteDirections
 * **Example:** GetRouteDirections from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Azure.Maps.Account("maps");
 *     // init: assigns AzureMapsRouteReadRole on the account
 *     const getRouteDirections = yield* Azure.Maps.GetRouteDirections(account);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: x-ms-client-id is filled in
 *         const route = yield* getRouteDirections({
 *   type: "FeatureCollection",
 *   features: [
 *     { type: "Feature", geometry: { type: "Point", coordinates: [-122.201399, 47.608678] }, properties: { pointIndex: 0, pointType: "waypoint" } },
 *     { type: "Feature", geometry: { type: "Point", coordinates: [-122.20687, 47.612002] }, properties: { pointIndex: 1, pointType: "waypoint" } },
 *   ],
 *   travelMode: "driving",
 * });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Maps.GetRouteDirectionsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Maps
 */
export interface GetRouteDirections extends Binding.Service<
  GetRouteDirections,
  "Azure.Maps.GetRouteDirections",
  (account: Account) => Effect.Effect<GetRouteDirectionsClient>
> {}

export const GetRouteDirections = Binding.Service<GetRouteDirections>(
  "Azure.Maps.GetRouteDirections",
);
