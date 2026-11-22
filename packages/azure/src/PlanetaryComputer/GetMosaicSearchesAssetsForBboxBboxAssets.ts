import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicSearchesAssetsForBboxBboxAssets` request without `endpoint`, which
 * the bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicSearchesAssetsForBboxBboxAssetsRequest extends Omit<
  geocatalog.GetMosaicSearchesAssetsForBboxBboxAssetsRequest,
  "endpoint"
> {}

/**
 * Searches Assets For Bbox Return a list of assets which overlap a given
 * bounding box for a search.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicSearchesAssetsForBboxBboxAssetsHttp}.
 *
 * ### Calling GetMosaicSearchesAssetsForBboxBboxAssets
 * **Example:** GetMosaicSearchesAssetsForBboxBboxAssets from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicSearchesAssetsForBboxBboxAssets = yield* Azure.PlanetaryComputer.GetMosaicSearchesAssetsForBboxBboxAssets(catalog);
 *
 * // runtime
 * const result = yield* getMosaicSearchesAssetsForBboxBboxAssets(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicSearchesAssetsForBboxBboxAssetsHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicSearchesAssetsForBboxBboxAssets extends Binding.Service<
  GetMosaicSearchesAssetsForBboxBboxAssets,
  "Azure.PlanetaryComputer.GetMosaicSearchesAssetsForBboxBboxAssets",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicSearchesAssetsForBboxBboxAssetsRequest,
    ) => Effect.Effect<
      geocatalog.GetMosaicSearchesAssetsForBboxBboxAssetsResponse,
      geocatalog.GetMosaicSearchesAssetsForBboxBboxAssetsError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicSearchesAssetsForBboxBboxAssets =
  Binding.Service<GetMosaicSearchesAssetsForBboxBboxAssets>(
    "Azure.PlanetaryComputer.GetMosaicSearchesAssetsForBboxBboxAssets",
  );
