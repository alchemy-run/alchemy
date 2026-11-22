import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicSearchesTileMatrixSetsScaleZxyByScale` request without `endpoint`,
 * which the bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicSearchesTileMatrixSetsScaleZxyByScaleRequest extends Omit<
  geocatalog.GetMosaicSearchesTileMatrixSetsScaleZxyByScaleRequest,
  "endpoint"
> {}

/**
 * Searches Tile Tilematrixsetid Scale Create map tile (with TileMatrixSetId and
 * scale, without format).
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicSearchesTileMatrixSetsScaleZxyByScaleHttp}.
 *
 * ### Calling GetMosaicSearchesTileMatrixSetsScaleZxyByScale
 * **Example:** GetMosaicSearchesTileMatrixSetsScaleZxyByScale from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicSearchesTileMatrixSetsScaleZxyByScale = yield* Azure.PlanetaryComputer.GetMosaicSearchesTileMatrixSetsScaleZxyByScale(catalog);
 *
 * // runtime
 * const result = yield* getMosaicSearchesTileMatrixSetsScaleZxyByScale(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicSearchesTileMatrixSetsScaleZxyByScaleHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicSearchesTileMatrixSetsScaleZxyByScale extends Binding.Service<
  GetMosaicSearchesTileMatrixSetsScaleZxyByScale,
  "Azure.PlanetaryComputer.GetMosaicSearchesTileMatrixSetsScaleZxyByScale",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicSearchesTileMatrixSetsScaleZxyByScaleRequest,
    ) => Effect.Effect<
      geocatalog.GetMosaicSearchesTileMatrixSetsScaleZxyByScaleResponse,
      geocatalog.GetMosaicSearchesTileMatrixSetsScaleZxyByScaleError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicSearchesTileMatrixSetsScaleZxyByScale =
  Binding.Service<GetMosaicSearchesTileMatrixSetsScaleZxyByScale>(
    "Azure.PlanetaryComputer.GetMosaicSearchesTileMatrixSetsScaleZxyByScale",
  );
