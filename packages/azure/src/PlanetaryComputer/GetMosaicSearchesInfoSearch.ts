import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicSearchesInfoSearch` request without `endpoint`, which the bound
 * GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicSearchesInfoSearchRequest extends Omit<
  geocatalog.GetMosaicSearchesInfoSearchRequest,
  "endpoint"
> {}

/**
 * Searches Info Get Search query metadata.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicSearchesInfoSearchHttp}.
 *
 * ### Calling GetMosaicSearchesInfoSearch
 * **Example:** GetMosaicSearchesInfoSearch from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicSearchesInfoSearch = yield* Azure.PlanetaryComputer.GetMosaicSearchesInfoSearch(catalog);
 *
 * // runtime
 * const result = yield* getMosaicSearchesInfoSearch(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicSearchesInfoSearchHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicSearchesInfoSearch extends Binding.Service<
  GetMosaicSearchesInfoSearch,
  "Azure.PlanetaryComputer.GetMosaicSearchesInfoSearch",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicSearchesInfoSearchRequest,
    ) => Effect.Effect<
      geocatalog.TilerStacSearchRegistration,
      geocatalog.GetMosaicSearchesInfoSearchError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicSearchesInfoSearch = Binding.Service<GetMosaicSearchesInfoSearch>(
  "Azure.PlanetaryComputer.GetMosaicSearchesInfoSearch",
);
