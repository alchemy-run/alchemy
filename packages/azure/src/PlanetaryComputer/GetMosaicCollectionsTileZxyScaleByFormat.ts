import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicCollectionsTileZxyScaleByFormat` request without `endpoint`, which
 * the bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicCollectionsTileZxyScaleByFormatRequest extends Omit<
  geocatalog.GetMosaicCollectionsTileZxyScaleByFormatRequest,
  "endpoint"
> {}

/**
 * Collection Tile Create map tile for a STAC collection (without
 * TileMatrixSetId, with scale and format).
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicCollectionsTileZxyScaleByFormatHttp}.
 *
 * ### Calling GetMosaicCollectionsTileZxyScaleByFormat
 * **Example:** GetMosaicCollectionsTileZxyScaleByFormat from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicCollectionsTileZxyScaleByFormat = yield* Azure.PlanetaryComputer.GetMosaicCollectionsTileZxyScaleByFormat(catalog);
 *
 * // runtime
 * const result = yield* getMosaicCollectionsTileZxyScaleByFormat(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicCollectionsTileZxyScaleByFormatHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicCollectionsTileZxyScaleByFormat extends Binding.Service<
  GetMosaicCollectionsTileZxyScaleByFormat,
  "Azure.PlanetaryComputer.GetMosaicCollectionsTileZxyScaleByFormat",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicCollectionsTileZxyScaleByFormatRequest,
    ) => Effect.Effect<
      geocatalog.GetMosaicCollectionsTileZxyScaleByFormatResponse,
      geocatalog.GetMosaicCollectionsTileZxyScaleByFormatError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicCollectionsTileZxyScaleByFormat =
  Binding.Service<GetMosaicCollectionsTileZxyScaleByFormat>(
    "Azure.PlanetaryComputer.GetMosaicCollectionsTileZxyScaleByFormat",
  );
