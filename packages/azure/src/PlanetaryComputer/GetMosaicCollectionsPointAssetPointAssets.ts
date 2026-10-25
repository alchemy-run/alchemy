import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicCollectionsPointAssetPointAssets` request without `endpoint`, which
 * the bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicCollectionsPointAssetPointAssetsRequest extends Omit<
  geocatalog.GetMosaicCollectionsPointAssetPointAssetsRequest,
  "endpoint"
> {}

/**
 * Collection Point Assets Return a list of assets for a given point in a
 * collection.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicCollectionsPointAssetPointAssetsHttp}.
 *
 * ### Calling GetMosaicCollectionsPointAssetPointAssets
 * **Example:** GetMosaicCollectionsPointAssetPointAssets from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicCollectionsPointAssetPointAssets = yield* Azure.PlanetaryComputer.GetMosaicCollectionsPointAssetPointAssets(catalog);
 *
 * // runtime
 * const result = yield* getMosaicCollectionsPointAssetPointAssets(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicCollectionsPointAssetPointAssetsHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicCollectionsPointAssetPointAssets extends Binding.Service<
  GetMosaicCollectionsPointAssetPointAssets,
  "Azure.PlanetaryComputer.GetMosaicCollectionsPointAssetPointAssets",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicCollectionsPointAssetPointAssetsRequest,
    ) => Effect.Effect<
      geocatalog.GetMosaicCollectionsPointAssetPointAssetsResponse,
      geocatalog.GetMosaicCollectionsPointAssetPointAssetsError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicCollectionsPointAssetPointAssets =
  Binding.Service<GetMosaicCollectionsPointAssetPointAssets>(
    "Azure.PlanetaryComputer.GetMosaicCollectionsPointAssetPointAssets",
  );
