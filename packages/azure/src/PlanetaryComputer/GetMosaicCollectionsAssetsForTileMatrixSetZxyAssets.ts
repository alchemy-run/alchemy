import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicCollectionsAssetsForTileMatrixSetZxyAssets` request without
 * `endpoint`, which the bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicCollectionsAssetsForTileMatrixSetZxyAssetsRequest extends Omit<
  geocatalog.GetMosaicCollectionsAssetsForTileMatrixSetZxyAssetsRequest,
  "endpoint"
> {}

/**
 * Collection Assets For Tile Tilematrixsetid As Path Return a list of assets
 * which overlap a given tile for a STAC collection (with TileMatrixSetId).
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicCollectionsAssetsForTileMatrixSetZxyAssetsHttp}.
 *
 * ### Calling GetMosaicCollectionsAssetsForTileMatrixSetZxyAssets
 * **Example:** GetMosaicCollectionsAssetsForTileMatrixSetZxyAssets from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicCollectionsAssetsForTileMatrixSetZxyAssets = yield* Azure.PlanetaryComputer.GetMosaicCollectionsAssetsForTileMatrixSetZxyAssets(catalog);
 *
 * // runtime
 * const result = yield* getMosaicCollectionsAssetsForTileMatrixSetZxyAssets(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicCollectionsAssetsForTileMatrixSetZxyAssetsHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicCollectionsAssetsForTileMatrixSetZxyAssets extends Binding.Service<
  GetMosaicCollectionsAssetsForTileMatrixSetZxyAssets,
  "Azure.PlanetaryComputer.GetMosaicCollectionsAssetsForTileMatrixSetZxyAssets",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicCollectionsAssetsForTileMatrixSetZxyAssetsRequest,
    ) => Effect.Effect<
      geocatalog.GetMosaicCollectionsAssetsForTileMatrixSetZxyAssetsResponse,
      geocatalog.GetMosaicCollectionsAssetsForTileMatrixSetZxyAssetsError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicCollectionsAssetsForTileMatrixSetZxyAssets =
  Binding.Service<GetMosaicCollectionsAssetsForTileMatrixSetZxyAssets>(
    "Azure.PlanetaryComputer.GetMosaicCollectionsAssetsForTileMatrixSetZxyAssets",
  );
