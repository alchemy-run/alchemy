import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicSearchesAssetsForTileMatrixSetZxyAssets` request without
 * `endpoint`, which the bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicSearchesAssetsForTileMatrixSetZxyAssetsRequest extends Omit<
  geocatalog.GetMosaicSearchesAssetsForTileMatrixSetZxyAssetsRequest,
  "endpoint"
> {}

/**
 * Searches Assets For Tile Tilematrixsetid As Path Return a list of assets
 * which overlap a given tile.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicSearchesAssetsForTileMatrixSetZxyAssetsHttp}.
 *
 * ### Calling GetMosaicSearchesAssetsForTileMatrixSetZxyAssets
 * **Example:** GetMosaicSearchesAssetsForTileMatrixSetZxyAssets from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicSearchesAssetsForTileMatrixSetZxyAssets = yield* Azure.PlanetaryComputer.GetMosaicSearchesAssetsForTileMatrixSetZxyAssets(catalog);
 *
 * // runtime
 * const result = yield* getMosaicSearchesAssetsForTileMatrixSetZxyAssets(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicSearchesAssetsForTileMatrixSetZxyAssetsHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicSearchesAssetsForTileMatrixSetZxyAssets extends Binding.Service<
  GetMosaicSearchesAssetsForTileMatrixSetZxyAssets,
  "Azure.PlanetaryComputer.GetMosaicSearchesAssetsForTileMatrixSetZxyAssets",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicSearchesAssetsForTileMatrixSetZxyAssetsRequest,
    ) => Effect.Effect<
      geocatalog.GetMosaicSearchesAssetsForTileMatrixSetZxyAssetsResponse,
      geocatalog.GetMosaicSearchesAssetsForTileMatrixSetZxyAssetsError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicSearchesAssetsForTileMatrixSetZxyAssets =
  Binding.Service<GetMosaicSearchesAssetsForTileMatrixSetZxyAssets>(
    "Azure.PlanetaryComputer.GetMosaicSearchesAssetsForTileMatrixSetZxyAssets",
  );
