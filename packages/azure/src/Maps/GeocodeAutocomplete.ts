import type * as search from "@distilled.cloud/azure/maps-search";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

/** A `GeocodeAutocomplete` request; the bound account supplies `x-ms-client-id`. */
export interface GeocodeAutocompleteRequest extends Omit<
  search.SearchGetGeocodeAutocompleteRequest,
  "xMsClientId"
> {}

/** Runtime callable of {@link GeocodeAutocomplete}. */
export type GeocodeAutocompleteClient = (
  request: GeocodeAutocompleteRequest,
) => Effect.Effect<
  search.AutocompleteResponse,
  search.SearchGetGeocodeAutocompleteError,
  RuntimeContext
>;

/**
 * Suggest addresses and places for a partial query. Calls Azure Maps from any host with Microsoft Entra ID,
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
 * Provide {@link GeocodeAutocompleteHttp}.
 *
 * ### Calling GeocodeAutocomplete
 * **Example:** GeocodeAutocomplete from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Azure.Maps.Account("maps");
 *     // init: assigns AzureMapsSearchReadRole on the account
 *     const geocodeAutocomplete = yield* Azure.Maps.GeocodeAutocomplete(account);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: x-ms-client-id is filled in
 *         const { features } = yield* geocodeAutocomplete({ query: "1 Microsoft Way, Redm", coordinates: "-122.13,47.64" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Maps.GeocodeAutocompleteHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Maps
 */
export interface GeocodeAutocomplete extends Binding.Service<
  GeocodeAutocomplete,
  "Azure.Maps.GeocodeAutocomplete",
  (account: Account) => Effect.Effect<GeocodeAutocompleteClient>
> {}

export const GeocodeAutocomplete = Binding.Service<GeocodeAutocomplete>(
  "Azure.Maps.GeocodeAutocomplete",
);
