import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicSearchesAssetsForTileZxyAssets` request without `endpoint`, which
 * the bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicSearchesAssetsForTileZxyAssetsRequest extends Omit<
  geocatalog.GetMosaicSearchesAssetsForTileZxyAssetsRequest,
  "endpoint"
> {}

/**
 * Searches Assets For Tile The most basic operation.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicSearchesAssetsForTileZxyAssetsHttp}.
 *
 * ### Calling GetMosaicSearchesAssetsForTileZxyAssets
 * **Example:** GetMosaicSearchesAssetsForTileZxyAssets from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicSearchesAssetsForTileZxyAssets = yield* Azure.PlanetaryComputer.GetMosaicSearchesAssetsForTileZxyAssets(catalog);
 *
 * // runtime
 * const result = yield* getMosaicSearchesAssetsForTileZxyAssets(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicSearchesAssetsForTileZxyAssetsHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicSearchesAssetsForTileZxyAssets extends Binding.Service<
  GetMosaicSearchesAssetsForTileZxyAssets,
  "Azure.PlanetaryComputer.GetMosaicSearchesAssetsForTileZxyAssets",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicSearchesAssetsForTileZxyAssetsRequest,
    ) => Effect.Effect<
      geocatalog.GetMosaicSearchesAssetsForTileZxyAssetsResponse,
      geocatalog.GetMosaicSearchesAssetsForTileZxyAssetsError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicSearchesAssetsForTileZxyAssets =
  Binding.Service<GetMosaicSearchesAssetsForTileZxyAssets>(
    "Azure.PlanetaryComputer.GetMosaicSearchesAssetsForTileZxyAssets",
  );
