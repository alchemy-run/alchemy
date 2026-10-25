import type * as route from "@distilled.cloud/azure/maps-route";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

/** A `GetRouteRangeBatch` request; the bound account supplies `x-ms-client-id`. */
export interface GetRouteRangeBatchRequest extends Omit<
  route.PostRouteRouteRangeBatchRequest,
  "xMsClientId"
> {}

/** Runtime callable of {@link GetRouteRangeBatch}. */
export type GetRouteRangeBatchClient = (
  request: GetRouteRangeBatchRequest,
) => Effect.Effect<
  route.RouteRangeBatchResponse,
  route.PostRouteRouteRangeBatchError,
  RuntimeContext
>;

/**
 * Compute up to 100 reachable ranges in one synchronous batch. Calls Azure Maps from any host with Microsoft Entra ID,
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
 * Provide {@link GetRouteRangeBatchHttp}.
 *
 * ### Calling GetRouteRangeBatch
 * **Example:** GetRouteRangeBatch from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Azure.Maps.Account("maps");
 *     // init: assigns AzureMapsRouteReadRole and AzureMapsBatchRole on the account
 *     const getRouteRangeBatch = yield* Azure.Maps.GetRouteRangeBatch(account);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: x-ms-client-id is filled in
 *         const { batchItems } = yield* getRouteRangeBatch({ batchItems: [{ optionalId: "a", type: "Feature", geometry, properties: { distanceBudgetInMeters: 5000 } }] });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Maps.GetRouteRangeBatchHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Maps
 */
export interface GetRouteRangeBatch extends Binding.Service<
  GetRouteRangeBatch,
  "Azure.Maps.GetRouteRangeBatch",
  (account: Account) => Effect.Effect<GetRouteRangeBatchClient>
> {}

export const GetRouteRangeBatch = Binding.Service<GetRouteRangeBatch>(
  "Azure.Maps.GetRouteRangeBatch",
);
