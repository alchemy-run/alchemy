import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicSearchesPointWithAssetPointAssets` request without `endpoint`,
 * which the bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicSearchesPointWithAssetPointAssetsRequest extends Omit<
  geocatalog.GetMosaicSearchesPointWithAssetPointAssetsRequest,
  "endpoint"
> {}

/**
 * Searches Point Assets Return a list of assets for a given point in a search.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicSearchesPointWithAssetPointAssetsHttp}.
 *
 * ### Calling GetMosaicSearchesPointWithAssetPointAssets
 * **Example:** GetMosaicSearchesPointWithAssetPointAssets from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicSearchesPointWithAssetPointAssets = yield* Azure.PlanetaryComputer.GetMosaicSearchesPointWithAssetPointAssets(catalog);
 *
 * // runtime
 * const result = yield* getMosaicSearchesPointWithAssetPointAssets(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicSearchesPointWithAssetPointAssetsHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicSearchesPointWithAssetPointAssets extends Binding.Service<
  GetMosaicSearchesPointWithAssetPointAssets,
  "Azure.PlanetaryComputer.GetMosaicSearchesPointWithAssetPointAssets",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicSearchesPointWithAssetPointAssetsRequest,
    ) => Effect.Effect<
      geocatalog.GetMosaicSearchesPointWithAssetPointAssetsResponse,
      geocatalog.GetMosaicSearchesPointWithAssetPointAssetsError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicSearchesPointWithAssetPointAssets =
  Binding.Service<GetMosaicSearchesPointWithAssetPointAssets>(
    "Azure.PlanetaryComputer.GetMosaicSearchesPointWithAssetPointAssets",
  );
