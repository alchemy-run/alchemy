import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicCollectionsAssetsForBboxBboxAssets` request without `endpoint`,
 * which the bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicCollectionsAssetsForBboxBboxAssetsRequest extends Omit<
  geocatalog.GetMosaicCollectionsAssetsForBboxBboxAssetsRequest,
  "endpoint"
> {}

/**
 * Collection Assets For Bbox Return a list of assets which overlap a given
 * bounding box for a STAC collection.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicCollectionsAssetsForBboxBboxAssetsHttp}.
 *
 * ### Calling GetMosaicCollectionsAssetsForBboxBboxAssets
 * **Example:** GetMosaicCollectionsAssetsForBboxBboxAssets from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicCollectionsAssetsForBboxBboxAssets = yield* Azure.PlanetaryComputer.GetMosaicCollectionsAssetsForBboxBboxAssets(catalog);
 *
 * // runtime
 * const result = yield* getMosaicCollectionsAssetsForBboxBboxAssets(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicCollectionsAssetsForBboxBboxAssetsHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicCollectionsAssetsForBboxBboxAssets extends Binding.Service<
  GetMosaicCollectionsAssetsForBboxBboxAssets,
  "Azure.PlanetaryComputer.GetMosaicCollectionsAssetsForBboxBboxAssets",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicCollectionsAssetsForBboxBboxAssetsRequest,
    ) => Effect.Effect<
      geocatalog.GetMosaicCollectionsAssetsForBboxBboxAssetsResponse,
      geocatalog.GetMosaicCollectionsAssetsForBboxBboxAssetsError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicCollectionsAssetsForBboxBboxAssets =
  Binding.Service<GetMosaicCollectionsAssetsForBboxBboxAssets>(
    "Azure.PlanetaryComputer.GetMosaicCollectionsAssetsForBboxBboxAssets",
  );
