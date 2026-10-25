import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicItemsTileSetList` request without `endpoint`, which the bound
 * GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicItemsTileSetListRequest extends Omit<
  geocatalog.GetMosaicItemsTileSetListRequest,
  "endpoint"
> {}

/**
 * Tileset List Return a list of available tilesets for a STAC item.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicItemsTileSetListHttp}.
 *
 * ### Calling GetMosaicItemsTileSetList
 * **Example:** GetMosaicItemsTileSetList from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicItemsTileSetList = yield* Azure.PlanetaryComputer.GetMosaicItemsTileSetList(catalog);
 *
 * // runtime
 * const result = yield* getMosaicItemsTileSetList(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicItemsTileSetListHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicItemsTileSetList extends Binding.Service<
  GetMosaicItemsTileSetList,
  "Azure.PlanetaryComputer.GetMosaicItemsTileSetList",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicItemsTileSetListRequest,
    ) => Effect.Effect<
      geocatalog.TileSetList,
      geocatalog.GetMosaicItemsTileSetListError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicItemsTileSetList = Binding.Service<GetMosaicItemsTileSetList>(
  "Azure.PlanetaryComputer.GetMosaicItemsTileSetList",
);
