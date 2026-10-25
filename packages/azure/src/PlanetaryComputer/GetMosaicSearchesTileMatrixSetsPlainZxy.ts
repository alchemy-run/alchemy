import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicSearchesTileMatrixSetsPlainZxy` request without `endpoint`, which
 * the bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicSearchesTileMatrixSetsPlainZxyRequest extends Omit<
  geocatalog.GetMosaicSearchesTileMatrixSetsPlainZxyRequest,
  "endpoint"
> {}

/**
 * Searches Tile Tilematrixsetid Plain Create map tile (with TileMatrixSetId,
 * without scale or format).
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicSearchesTileMatrixSetsPlainZxyHttp}.
 *
 * ### Calling GetMosaicSearchesTileMatrixSetsPlainZxy
 * **Example:** GetMosaicSearchesTileMatrixSetsPlainZxy from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicSearchesTileMatrixSetsPlainZxy = yield* Azure.PlanetaryComputer.GetMosaicSearchesTileMatrixSetsPlainZxy(catalog);
 *
 * // runtime
 * const result = yield* getMosaicSearchesTileMatrixSetsPlainZxy(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicSearchesTileMatrixSetsPlainZxyHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicSearchesTileMatrixSetsPlainZxy extends Binding.Service<
  GetMosaicSearchesTileMatrixSetsPlainZxy,
  "Azure.PlanetaryComputer.GetMosaicSearchesTileMatrixSetsPlainZxy",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicSearchesTileMatrixSetsPlainZxyRequest,
    ) => Effect.Effect<
      geocatalog.GetMosaicSearchesTileMatrixSetsPlainZxyResponse,
      geocatalog.GetMosaicSearchesTileMatrixSetsPlainZxyError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicSearchesTileMatrixSetsPlainZxy =
  Binding.Service<GetMosaicSearchesTileMatrixSetsPlainZxy>(
    "Azure.PlanetaryComputer.GetMosaicSearchesTileMatrixSetsPlainZxy",
  );
