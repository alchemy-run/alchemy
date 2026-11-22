import type * as search from "@distilled.cloud/azure/maps-search";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

/** A `Geocode` request; the bound account supplies `x-ms-client-id`. */
export interface GeocodeRequest extends Omit<search.SearchGetGeocodingRequest, "xMsClientId"> {}

/** Runtime callable of {@link Geocode}. */
export type GeocodeClient = (
  request: GeocodeRequest,
) => Effect.Effect<search.GeocodingResponse, search.SearchGetGeocodingError, RuntimeContext>;

/**
 * Get the coordinates of an address, landmark or place (forward geocoding). Calls Azure Maps from any host with Microsoft Entra ID,
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
 * Provide {@link GeocodeHttp}.
 *
 * ### Calling Geocode
 * **Example:** Geocode from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Azure.Maps.Account("maps");
 *     // init: assigns AzureMapsSearchReadRole on the account
 *     const geocode = yield* Azure.Maps.Geocode(account);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: x-ms-client-id is filled in
 *         const { features } = yield* geocode({ query: "15127 NE 24th Street, Redmond, WA 98052" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Maps.GeocodeHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Maps
 */
export interface Geocode extends Binding.Service<
  Geocode,
  "Azure.Maps.Geocode",
  (account: Account) => Effect.Effect<GeocodeClient>
> {}

export const Geocode = Binding.Service<Geocode>("Azure.Maps.Geocode");
