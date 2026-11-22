import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicSearchesTileMatrixSetZxyScaleByFormat` request without `endpoint`,
 * which the bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicSearchesTileMatrixSetZxyScaleByFormatRequest extends Omit<
  geocatalog.GetMosaicSearchesTileMatrixSetZxyScaleByFormatRequest,
  "endpoint"
> {}

/**
 * Searches Tile Tilematrixsetid Create map tile (with TileMatrixSetId, scale,
 * and format in path).
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicSearchesTileMatrixSetZxyScaleByFormatHttp}.
 *
 * ### Calling GetMosaicSearchesTileMatrixSetZxyScaleByFormat
 * **Example:** GetMosaicSearchesTileMatrixSetZxyScaleByFormat from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicSearchesTileMatrixSetZxyScaleByFormat = yield* Azure.PlanetaryComputer.GetMosaicSearchesTileMatrixSetZxyScaleByFormat(catalog);
 *
 * // runtime
 * const result = yield* getMosaicSearchesTileMatrixSetZxyScaleByFormat(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicSearchesTileMatrixSetZxyScaleByFormatHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicSearchesTileMatrixSetZxyScaleByFormat extends Binding.Service<
  GetMosaicSearchesTileMatrixSetZxyScaleByFormat,
  "Azure.PlanetaryComputer.GetMosaicSearchesTileMatrixSetZxyScaleByFormat",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicSearchesTileMatrixSetZxyScaleByFormatRequest,
    ) => Effect.Effect<
      geocatalog.GetMosaicSearchesTileMatrixSetZxyScaleByFormatResponse,
      geocatalog.GetMosaicSearchesTileMatrixSetZxyScaleByFormatError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicSearchesTileMatrixSetZxyScaleByFormat =
  Binding.Service<GetMosaicSearchesTileMatrixSetZxyScaleByFormat>(
    "Azure.PlanetaryComputer.GetMosaicSearchesTileMatrixSetZxyScaleByFormat",
  );
