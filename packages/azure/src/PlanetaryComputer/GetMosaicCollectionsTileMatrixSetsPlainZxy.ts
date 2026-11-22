import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicCollectionsTileMatrixSetsPlainZxy` request without `endpoint`,
 * which the bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicCollectionsTileMatrixSetsPlainZxyRequest extends Omit<
  geocatalog.GetMosaicCollectionsTileMatrixSetsPlainZxyRequest,
  "endpoint"
> {}

/**
 * Collection Tile Tilematrixsetid Plain Create map tile for a STAC collection
 * (with TileMatrixSetId, without scale or format).
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicCollectionsTileMatrixSetsPlainZxyHttp}.
 *
 * ### Calling GetMosaicCollectionsTileMatrixSetsPlainZxy
 * **Example:** GetMosaicCollectionsTileMatrixSetsPlainZxy from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicCollectionsTileMatrixSetsPlainZxy = yield* Azure.PlanetaryComputer.GetMosaicCollectionsTileMatrixSetsPlainZxy(catalog);
 *
 * // runtime
 * const result = yield* getMosaicCollectionsTileMatrixSetsPlainZxy(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicCollectionsTileMatrixSetsPlainZxyHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicCollectionsTileMatrixSetsPlainZxy extends Binding.Service<
  GetMosaicCollectionsTileMatrixSetsPlainZxy,
  "Azure.PlanetaryComputer.GetMosaicCollectionsTileMatrixSetsPlainZxy",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicCollectionsTileMatrixSetsPlainZxyRequest,
    ) => Effect.Effect<
      geocatalog.GetMosaicCollectionsTileMatrixSetsPlainZxyResponse,
      geocatalog.GetMosaicCollectionsTileMatrixSetsPlainZxyError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicCollectionsTileMatrixSetsPlainZxy =
  Binding.Service<GetMosaicCollectionsTileMatrixSetsPlainZxy>(
    "Azure.PlanetaryComputer.GetMosaicCollectionsTileMatrixSetsPlainZxy",
  );
