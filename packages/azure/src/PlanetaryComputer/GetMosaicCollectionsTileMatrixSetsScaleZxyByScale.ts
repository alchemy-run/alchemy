import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicCollectionsTileMatrixSetsScaleZxyByScale` request without
 * `endpoint`, which the bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicCollectionsTileMatrixSetsScaleZxyByScaleRequest extends Omit<
  geocatalog.GetMosaicCollectionsTileMatrixSetsScaleZxyByScaleRequest,
  "endpoint"
> {}

/**
 * Collection Tile Tilematrixsetid Scale Create map tile for a STAC collection
 * (with TileMatrixSetId and scale, without format).
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicCollectionsTileMatrixSetsScaleZxyByScaleHttp}.
 *
 * ### Calling GetMosaicCollectionsTileMatrixSetsScaleZxyByScale
 * **Example:** GetMosaicCollectionsTileMatrixSetsScaleZxyByScale from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicCollectionsTileMatrixSetsScaleZxyByScale = yield* Azure.PlanetaryComputer.GetMosaicCollectionsTileMatrixSetsScaleZxyByScale(catalog);
 *
 * // runtime
 * const result = yield* getMosaicCollectionsTileMatrixSetsScaleZxyByScale(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicCollectionsTileMatrixSetsScaleZxyByScaleHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicCollectionsTileMatrixSetsScaleZxyByScale extends Binding.Service<
  GetMosaicCollectionsTileMatrixSetsScaleZxyByScale,
  "Azure.PlanetaryComputer.GetMosaicCollectionsTileMatrixSetsScaleZxyByScale",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicCollectionsTileMatrixSetsScaleZxyByScaleRequest,
    ) => Effect.Effect<
      geocatalog.GetMosaicCollectionsTileMatrixSetsScaleZxyByScaleResponse,
      geocatalog.GetMosaicCollectionsTileMatrixSetsScaleZxyByScaleError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicCollectionsTileMatrixSetsScaleZxyByScale =
  Binding.Service<GetMosaicCollectionsTileMatrixSetsScaleZxyByScale>(
    "Azure.PlanetaryComputer.GetMosaicCollectionsTileMatrixSetsScaleZxyByScale",
  );
