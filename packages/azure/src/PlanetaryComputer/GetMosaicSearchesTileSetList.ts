import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicSearchesTileSetList` request without `endpoint`, which the bound
 * GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicSearchesTileSetListRequest extends Omit<
  geocatalog.GetMosaicSearchesTileSetListRequest,
  "endpoint"
> {}

/**
 * Searches Tileset List Return a list of available tilesets for a mosaic
 * search.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicSearchesTileSetListHttp}.
 *
 * ### Calling GetMosaicSearchesTileSetList
 * **Example:** GetMosaicSearchesTileSetList from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicSearchesTileSetList = yield* Azure.PlanetaryComputer.GetMosaicSearchesTileSetList(catalog);
 *
 * // runtime
 * const result = yield* getMosaicSearchesTileSetList(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicSearchesTileSetListHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicSearchesTileSetList extends Binding.Service<
  GetMosaicSearchesTileSetList,
  "Azure.PlanetaryComputer.GetMosaicSearchesTileSetList",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicSearchesTileSetListRequest,
    ) => Effect.Effect<
      geocatalog.TileSetList,
      geocatalog.GetMosaicSearchesTileSetListError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicSearchesTileSetList = Binding.Service<GetMosaicSearchesTileSetList>(
  "Azure.PlanetaryComputer.GetMosaicSearchesTileSetList",
);
