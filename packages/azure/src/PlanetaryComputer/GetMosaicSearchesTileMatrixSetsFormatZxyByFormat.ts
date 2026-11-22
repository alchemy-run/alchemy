import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicSearchesTileMatrixSetsFormatZxyByFormat` request without
 * `endpoint`, which the bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicSearchesTileMatrixSetsFormatZxyByFormatRequest extends Omit<
  geocatalog.GetMosaicSearchesTileMatrixSetsFormatZxyByFormatRequest,
  "endpoint"
> {}

/**
 * Searches Tile Tilematrixsetid Format Create map tile (with TileMatrixSetId
 * and format, without scale).
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicSearchesTileMatrixSetsFormatZxyByFormatHttp}.
 *
 * ### Calling GetMosaicSearchesTileMatrixSetsFormatZxyByFormat
 * **Example:** GetMosaicSearchesTileMatrixSetsFormatZxyByFormat from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicSearchesTileMatrixSetsFormatZxyByFormat = yield* Azure.PlanetaryComputer.GetMosaicSearchesTileMatrixSetsFormatZxyByFormat(catalog);
 *
 * // runtime
 * const result = yield* getMosaicSearchesTileMatrixSetsFormatZxyByFormat(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicSearchesTileMatrixSetsFormatZxyByFormatHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicSearchesTileMatrixSetsFormatZxyByFormat extends Binding.Service<
  GetMosaicSearchesTileMatrixSetsFormatZxyByFormat,
  "Azure.PlanetaryComputer.GetMosaicSearchesTileMatrixSetsFormatZxyByFormat",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicSearchesTileMatrixSetsFormatZxyByFormatRequest,
    ) => Effect.Effect<
      geocatalog.GetMosaicSearchesTileMatrixSetsFormatZxyByFormatResponse,
      geocatalog.GetMosaicSearchesTileMatrixSetsFormatZxyByFormatError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicSearchesTileMatrixSetsFormatZxyByFormat =
  Binding.Service<GetMosaicSearchesTileMatrixSetsFormatZxyByFormat>(
    "Azure.PlanetaryComputer.GetMosaicSearchesTileMatrixSetsFormatZxyByFormat",
  );
