import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicCollectionsTileMatrixSetsFormatZxyByFormat` request without
 * `endpoint`, which the bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicCollectionsTileMatrixSetsFormatZxyByFormatRequest extends Omit<
  geocatalog.GetMosaicCollectionsTileMatrixSetsFormatZxyByFormatRequest,
  "endpoint"
> {}

/**
 * Collection Tile Tilematrixsetid Format Create map tile for a STAC collection
 * (with TileMatrixSetId and format, without scale).
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicCollectionsTileMatrixSetsFormatZxyByFormatHttp}.
 *
 * ### Calling GetMosaicCollectionsTileMatrixSetsFormatZxyByFormat
 * **Example:** GetMosaicCollectionsTileMatrixSetsFormatZxyByFormat from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicCollectionsTileMatrixSetsFormatZxyByFormat = yield* Azure.PlanetaryComputer.GetMosaicCollectionsTileMatrixSetsFormatZxyByFormat(catalog);
 *
 * // runtime
 * const result = yield* getMosaicCollectionsTileMatrixSetsFormatZxyByFormat(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicCollectionsTileMatrixSetsFormatZxyByFormatHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicCollectionsTileMatrixSetsFormatZxyByFormat extends Binding.Service<
  GetMosaicCollectionsTileMatrixSetsFormatZxyByFormat,
  "Azure.PlanetaryComputer.GetMosaicCollectionsTileMatrixSetsFormatZxyByFormat",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicCollectionsTileMatrixSetsFormatZxyByFormatRequest,
    ) => Effect.Effect<
      geocatalog.GetMosaicCollectionsTileMatrixSetsFormatZxyByFormatResponse,
      geocatalog.GetMosaicCollectionsTileMatrixSetsFormatZxyByFormatError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicCollectionsTileMatrixSetsFormatZxyByFormat =
  Binding.Service<GetMosaicCollectionsTileMatrixSetsFormatZxyByFormat>(
    "Azure.PlanetaryComputer.GetMosaicCollectionsTileMatrixSetsFormatZxyByFormat",
  );
