import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicCollectionsAssetsForTileZxyAssets` request without `endpoint`,
 * which the bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicCollectionsAssetsForTileZxyAssetsRequest extends Omit<
  geocatalog.GetMosaicCollectionsAssetsForTileZxyAssetsRequest,
  "endpoint"
> {}

/**
 * Collection Assets For Tile Return a list of assets which overlap a given tile
 * for a STAC collection (without TileMatrixSetId).
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicCollectionsAssetsForTileZxyAssetsHttp}.
 *
 * ### Calling GetMosaicCollectionsAssetsForTileZxyAssets
 * **Example:** GetMosaicCollectionsAssetsForTileZxyAssets from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicCollectionsAssetsForTileZxyAssets = yield* Azure.PlanetaryComputer.GetMosaicCollectionsAssetsForTileZxyAssets(catalog);
 *
 * // runtime
 * const result = yield* getMosaicCollectionsAssetsForTileZxyAssets(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicCollectionsAssetsForTileZxyAssetsHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicCollectionsAssetsForTileZxyAssets extends Binding.Service<
  GetMosaicCollectionsAssetsForTileZxyAssets,
  "Azure.PlanetaryComputer.GetMosaicCollectionsAssetsForTileZxyAssets",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicCollectionsAssetsForTileZxyAssetsRequest,
    ) => Effect.Effect<
      geocatalog.GetMosaicCollectionsAssetsForTileZxyAssetsResponse,
      geocatalog.GetMosaicCollectionsAssetsForTileZxyAssetsError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicCollectionsAssetsForTileZxyAssets =
  Binding.Service<GetMosaicCollectionsAssetsForTileZxyAssets>(
    "Azure.PlanetaryComputer.GetMosaicCollectionsAssetsForTileZxyAssets",
  );
