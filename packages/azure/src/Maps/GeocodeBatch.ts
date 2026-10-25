import type * as search from "@distilled.cloud/azure/maps-search";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

/** A `GeocodeBatch` request; the bound account supplies `x-ms-client-id`. */
export interface GeocodeBatchRequest extends Omit<
  search.SearchGetGeocodingBatchRequest,
  "xMsClientId"
> {}

/** Runtime callable of {@link GeocodeBatch}. */
export type GeocodeBatchClient = (
  request: GeocodeBatchRequest,
) => Effect.Effect<
  search.GeocodingBatchResponse,
  search.SearchGetGeocodingBatchError,
  RuntimeContext
>;

/**
 * Geocode up to 100 queries in one call. Calls Azure Maps from any host with Microsoft Entra ID,
 * sending the bound account's unique ID as `x-ms-client-id`.
 *
 * Binding assigns two custom roles (one each per stack): `AzureMapsSearchReadRole`
 * with exactly the data action `Microsoft.Maps/accounts/services/search/read`, and
 * `AzureMapsBatchRole` with exactly `Microsoft.Maps/accounts/services/batch/action`
 * (every `:batch` endpoint needs it), on the account only. The built-in
 * **Azure Maps Data Read and Batch Role** grants every Maps service.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal and client secret (see
 * `AzureBindings`).
 * Provide {@link GeocodeBatchHttp}.
 *
 * ### Calling GeocodeBatch
 * **Example:** GeocodeBatch from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Azure.Maps.Account("maps");
 *     // init: assigns AzureMapsSearchReadRole and AzureMapsBatchRole on the account
 *     const geocodeBatch = yield* Azure.Maps.GeocodeBatch(account);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: x-ms-client-id is filled in
 *         const { batchItems } = yield* geocodeBatch({ batchItems: [{ optionalId: "a", query: "One Microsoft Way, Redmond, WA 98052" }] });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Maps.GeocodeBatchHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Maps
 */
export interface GeocodeBatch extends Binding.Service<
  GeocodeBatch,
  "Azure.Maps.GeocodeBatch",
  (account: Account) => Effect.Effect<GeocodeBatchClient>
> {}

export const GeocodeBatch = Binding.Service<GeocodeBatch>("Azure.Maps.GeocodeBatch");
