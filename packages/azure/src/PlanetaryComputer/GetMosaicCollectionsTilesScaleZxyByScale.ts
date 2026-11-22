import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicCollectionsTilesScaleZxyByScale` request without `endpoint`, which
 * the bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicCollectionsTilesScaleZxyByScaleRequest extends Omit<
  geocatalog.GetMosaicCollectionsTilesScaleZxyByScaleRequest,
  "endpoint"
> {}

/**
 * Collection Tile Scale Create map tile for a STAC collection (with scale,
 * without TileMatrixSetId or format).
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicCollectionsTilesScaleZxyByScaleHttp}.
 *
 * ### Calling GetMosaicCollectionsTilesScaleZxyByScale
 * **Example:** GetMosaicCollectionsTilesScaleZxyByScale from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicCollectionsTilesScaleZxyByScale = yield* Azure.PlanetaryComputer.GetMosaicCollectionsTilesScaleZxyByScale(catalog);
 *
 * // runtime
 * const result = yield* getMosaicCollectionsTilesScaleZxyByScale(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicCollectionsTilesScaleZxyByScaleHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicCollectionsTilesScaleZxyByScale extends Binding.Service<
  GetMosaicCollectionsTilesScaleZxyByScale,
  "Azure.PlanetaryComputer.GetMosaicCollectionsTilesScaleZxyByScale",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicCollectionsTilesScaleZxyByScaleRequest,
    ) => Effect.Effect<
      geocatalog.GetMosaicCollectionsTilesScaleZxyByScaleResponse,
      geocatalog.GetMosaicCollectionsTilesScaleZxyByScaleError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicCollectionsTilesScaleZxyByScale =
  Binding.Service<GetMosaicCollectionsTilesScaleZxyByScale>(
    "Azure.PlanetaryComputer.GetMosaicCollectionsTilesScaleZxyByScale",
  );
