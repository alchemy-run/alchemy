import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicCollectionsTilesPlainZxy` request without `endpoint`, which the
 * bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicCollectionsTilesPlainZxyRequest extends Omit<
  geocatalog.GetMosaicCollectionsTilesPlainZxyRequest,
  "endpoint"
> {}

/**
 * Collection Tile Plain Create map tile for a STAC collection (without
 * TileMatrixSetId, scale, or format).
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicCollectionsTilesPlainZxyHttp}.
 *
 * ### Calling GetMosaicCollectionsTilesPlainZxy
 * **Example:** GetMosaicCollectionsTilesPlainZxy from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicCollectionsTilesPlainZxy = yield* Azure.PlanetaryComputer.GetMosaicCollectionsTilesPlainZxy(catalog);
 *
 * // runtime
 * const result = yield* getMosaicCollectionsTilesPlainZxy(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicCollectionsTilesPlainZxyHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicCollectionsTilesPlainZxy extends Binding.Service<
  GetMosaicCollectionsTilesPlainZxy,
  "Azure.PlanetaryComputer.GetMosaicCollectionsTilesPlainZxy",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicCollectionsTilesPlainZxyRequest,
    ) => Effect.Effect<
      geocatalog.GetMosaicCollectionsTilesPlainZxyResponse,
      geocatalog.GetMosaicCollectionsTilesPlainZxyError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicCollectionsTilesPlainZxy = Binding.Service<GetMosaicCollectionsTilesPlainZxy>(
  "Azure.PlanetaryComputer.GetMosaicCollectionsTilesPlainZxy",
);
