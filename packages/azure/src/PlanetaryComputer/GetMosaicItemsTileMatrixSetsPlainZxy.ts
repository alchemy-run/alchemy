import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicItemsTileMatrixSetsPlainZxy` request without `endpoint`, which the
 * bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicItemsTileMatrixSetsPlainZxyRequest extends Omit<
  geocatalog.GetMosaicItemsTileMatrixSetsPlainZxyRequest,
  "endpoint"
> {}

/**
 * Tile Tilematrixsetid Plain Create map tile from a dataset (without scale or
 * format in path).
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicItemsTileMatrixSetsPlainZxyHttp}.
 *
 * ### Calling GetMosaicItemsTileMatrixSetsPlainZxy
 * **Example:** GetMosaicItemsTileMatrixSetsPlainZxy from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicItemsTileMatrixSetsPlainZxy = yield* Azure.PlanetaryComputer.GetMosaicItemsTileMatrixSetsPlainZxy(catalog);
 *
 * // runtime
 * const result = yield* getMosaicItemsTileMatrixSetsPlainZxy(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicItemsTileMatrixSetsPlainZxyHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicItemsTileMatrixSetsPlainZxy extends Binding.Service<
  GetMosaicItemsTileMatrixSetsPlainZxy,
  "Azure.PlanetaryComputer.GetMosaicItemsTileMatrixSetsPlainZxy",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicItemsTileMatrixSetsPlainZxyRequest,
    ) => Effect.Effect<
      geocatalog.GetMosaicItemsTileMatrixSetsPlainZxyResponse,
      geocatalog.GetMosaicItemsTileMatrixSetsPlainZxyError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicItemsTileMatrixSetsPlainZxy =
  Binding.Service<GetMosaicItemsTileMatrixSetsPlainZxy>(
    "Azure.PlanetaryComputer.GetMosaicItemsTileMatrixSetsPlainZxy",
  );
