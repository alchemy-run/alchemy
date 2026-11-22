import type * as route from "@distilled.cloud/azure/maps-route";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

/** A `GetRouteMatrix` request; the bound account supplies `x-ms-client-id`. */
export interface GetRouteMatrixRequest extends Omit<
  route.PostRouteRouteMatrixRequest,
  "xMsClientId"
> {}

/** Runtime callable of {@link GetRouteMatrix}. */
export type GetRouteMatrixClient = (
  request: GetRouteMatrixRequest,
) => Effect.Effect<route.RouteMatrixResponse, route.PostRouteRouteMatrixError, RuntimeContext>;

/**
 * Compute travel times and distances between origins and destinations. Calls Azure Maps from any host with Microsoft Entra ID,
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
 * Provide {@link GetRouteMatrixHttp}.
 *
 * ### Calling GetRouteMatrix
 * **Example:** GetRouteMatrix from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Azure.Maps.Account("maps");
 *     // init: assigns AzureMapsRouteReadRole on the account
 *     const getRouteMatrix = yield* Azure.Maps.GetRouteMatrix(account);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: x-ms-client-id is filled in
 *         const matrix = yield* getRouteMatrix({
 *   type: "FeatureCollection",
 *   features: [
 *     { type: "Feature", geometry: { type: "MultiPoint", coordinates: [[9.15049, 45.458545]] }, properties: { pointType: "origins" } },
 *     { type: "Feature", geometry: { type: "MultiPoint", coordinates: [[9.15049, 45.458545], [11.050541, 45.403337]] }, properties: { pointType: "destinations" } },
 *   ],
 *   travelMode: "driving",
 * });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Maps.GetRouteMatrixHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Maps
 */
export interface GetRouteMatrix extends Binding.Service<
  GetRouteMatrix,
  "Azure.Maps.GetRouteMatrix",
  (account: Account) => Effect.Effect<GetRouteMatrixClient>
> {}

export const GetRouteMatrix = Binding.Service<GetRouteMatrix>("Azure.Maps.GetRouteMatrix");
