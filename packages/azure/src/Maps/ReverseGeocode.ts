import type * as search from "@distilled.cloud/azure/maps-search";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

/** A `ReverseGeocode` request; the bound account supplies `x-ms-client-id`. */
export interface ReverseGeocodeRequest extends Omit<
  search.SearchGetReverseGeocodingRequest,
  "xMsClientId"
> {}

/** Runtime callable of {@link ReverseGeocode}. */
export type ReverseGeocodeClient = (
  request: ReverseGeocodeRequest,
) => Effect.Effect<search.GeocodingResponse, search.SearchGetReverseGeocodingError, RuntimeContext>;

/**
 * Get the address of a coordinate (reverse geocoding). Calls Azure Maps from any host with Microsoft Entra ID,
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
 * Provide {@link ReverseGeocodeHttp}.
 *
 * ### Calling ReverseGeocode
 * **Example:** ReverseGeocode from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Azure.Maps.Account("maps");
 *     // init: assigns AzureMapsSearchReadRole on the account
 *     const reverseGeocode = yield* Azure.Maps.ReverseGeocode(account);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: x-ms-client-id is filled in
 *         const { features } = yield* reverseGeocode({ coordinates: "-122.138669,47.630356" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Maps.ReverseGeocodeHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Maps
 */
export interface ReverseGeocode extends Binding.Service<
  ReverseGeocode,
  "Azure.Maps.ReverseGeocode",
  (account: Account) => Effect.Effect<ReverseGeocodeClient>
> {}

export const ReverseGeocode = Binding.Service<ReverseGeocode>("Azure.Maps.ReverseGeocode");
