import type * as route from "@distilled.cloud/azure/maps-route";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

/** A `GetRouteDirectionsBatch` request; the bound account supplies `x-ms-client-id`. */
export interface GetRouteDirectionsBatchRequest extends Omit<
  route.PostRouteRouteDirectionsBatchRequest,
  "xMsClientId"
> {}

/** Runtime callable of {@link GetRouteDirectionsBatch}. */
export type GetRouteDirectionsBatchClient = (
  request: GetRouteDirectionsBatchRequest,
) => Effect.Effect<
  route.DirectionsBatchResponse,
  route.PostRouteRouteDirectionsBatchError,
  RuntimeContext
>;

/**
 * Compute up to 100 routes in one synchronous batch. Calls Azure Maps from any host with Microsoft Entra ID,
 * sending the bound account's unique ID as `x-ms-client-id`.
 *
 * Binding assigns two custom roles (one each per stack): `AzureMapsRouteReadRole`
 * with exactly the data action `Microsoft.Maps/accounts/services/route/read`, and
 * `AzureMapsBatchRole` with exactly `Microsoft.Maps/accounts/services/batch/action`
 * (every `:batch` endpoint needs it), on the account only. The built-in
 * **Azure Maps Data Read and Batch Role** grants every Maps service.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal and client secret (see
 * `AzureBindings`).
 * Provide {@link GetRouteDirectionsBatchHttp}.
 *
 * ### Calling GetRouteDirectionsBatch
 * **Example:** GetRouteDirectionsBatch from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Azure.Maps.Account("maps");
 *     // init: assigns AzureMapsRouteReadRole and AzureMapsBatchRole on the account
 *     const getRouteDirectionsBatch = yield* Azure.Maps.GetRouteDirectionsBatch(account);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: x-ms-client-id is filled in
 *         const { batchItems } = yield* getRouteDirectionsBatch({ batchItems: [{ optionalId: "a", type: "FeatureCollection", features }] });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Maps.GetRouteDirectionsBatchHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Maps
 */
export interface GetRouteDirectionsBatch extends Binding.Service<
  GetRouteDirectionsBatch,
  "Azure.Maps.GetRouteDirectionsBatch",
  (account: Account) => Effect.Effect<GetRouteDirectionsBatchClient>
> {}

export const GetRouteDirectionsBatch = Binding.Service<GetRouteDirectionsBatch>(
  "Azure.Maps.GetRouteDirectionsBatch",
);
