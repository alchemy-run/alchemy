import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicCollectionsTileMatrixSetZxyScaleByFormat` request without
 * `endpoint`, which the bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicCollectionsTileMatrixSetZxyScaleByFormatRequest extends Omit<
  geocatalog.GetMosaicCollectionsTileMatrixSetZxyScaleByFormatRequest,
  "endpoint"
> {}

/**
 * Collection Tile Tilematrixsetid Create map tile for a STAC collection (with
 * TileMatrixSetId, scale, and format in path).
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicCollectionsTileMatrixSetZxyScaleByFormatHttp}.
 *
 * ### Calling GetMosaicCollectionsTileMatrixSetZxyScaleByFormat
 * **Example:** GetMosaicCollectionsTileMatrixSetZxyScaleByFormat from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicCollectionsTileMatrixSetZxyScaleByFormat = yield* Azure.PlanetaryComputer.GetMosaicCollectionsTileMatrixSetZxyScaleByFormat(catalog);
 *
 * // runtime
 * const result = yield* getMosaicCollectionsTileMatrixSetZxyScaleByFormat(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicCollectionsTileMatrixSetZxyScaleByFormatHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicCollectionsTileMatrixSetZxyScaleByFormat extends Binding.Service<
  GetMosaicCollectionsTileMatrixSetZxyScaleByFormat,
  "Azure.PlanetaryComputer.GetMosaicCollectionsTileMatrixSetZxyScaleByFormat",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicCollectionsTileMatrixSetZxyScaleByFormatRequest,
    ) => Effect.Effect<
      geocatalog.GetMosaicCollectionsTileMatrixSetZxyScaleByFormatResponse,
      geocatalog.GetMosaicCollectionsTileMatrixSetZxyScaleByFormatError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicCollectionsTileMatrixSetZxyScaleByFormat =
  Binding.Service<GetMosaicCollectionsTileMatrixSetZxyScaleByFormat>(
    "Azure.PlanetaryComputer.GetMosaicCollectionsTileMatrixSetZxyScaleByFormat",
  );
