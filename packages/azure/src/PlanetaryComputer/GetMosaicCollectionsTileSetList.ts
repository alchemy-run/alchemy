import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicCollectionsTileSetList` request without `endpoint`, which the bound
 * GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicCollectionsTileSetListRequest extends Omit<
  geocatalog.GetMosaicCollectionsTileSetListRequest,
  "endpoint"
> {}

/**
 * Collection Tileset List Return a list of available tilesets for a STAC
 * collection.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicCollectionsTileSetListHttp}.
 *
 * ### Calling GetMosaicCollectionsTileSetList
 * **Example:** GetMosaicCollectionsTileSetList from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicCollectionsTileSetList = yield* Azure.PlanetaryComputer.GetMosaicCollectionsTileSetList(catalog);
 *
 * // runtime
 * const result = yield* getMosaicCollectionsTileSetList(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicCollectionsTileSetListHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicCollectionsTileSetList extends Binding.Service<
  GetMosaicCollectionsTileSetList,
  "Azure.PlanetaryComputer.GetMosaicCollectionsTileSetList",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicCollectionsTileSetListRequest,
    ) => Effect.Effect<
      geocatalog.TileSetList,
      geocatalog.GetMosaicCollectionsTileSetListError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicCollectionsTileSetList = Binding.Service<GetMosaicCollectionsTileSetList>(
  "Azure.PlanetaryComputer.GetMosaicCollectionsTileSetList",
);
