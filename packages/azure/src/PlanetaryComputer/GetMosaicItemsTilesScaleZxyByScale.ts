import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicItemsTilesScaleZxyByScale` request without `endpoint`, which the
 * bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicItemsTilesScaleZxyByScaleRequest extends Omit<
  geocatalog.GetMosaicItemsTilesScaleZxyByScaleRequest,
  "endpoint"
> {}

/**
 * Tile Scale Create map tile from a dataset (with scale in path, without
 * TileMatrixSetId or format).
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicItemsTilesScaleZxyByScaleHttp}.
 *
 * ### Calling GetMosaicItemsTilesScaleZxyByScale
 * **Example:** GetMosaicItemsTilesScaleZxyByScale from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicItemsTilesScaleZxyByScale = yield* Azure.PlanetaryComputer.GetMosaicItemsTilesScaleZxyByScale(catalog);
 *
 * // runtime
 * const result = yield* getMosaicItemsTilesScaleZxyByScale(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicItemsTilesScaleZxyByScaleHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicItemsTilesScaleZxyByScale extends Binding.Service<
  GetMosaicItemsTilesScaleZxyByScale,
  "Azure.PlanetaryComputer.GetMosaicItemsTilesScaleZxyByScale",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicItemsTilesScaleZxyByScaleRequest,
    ) => Effect.Effect<
      geocatalog.GetMosaicItemsTilesScaleZxyByScaleResponse,
      geocatalog.GetMosaicItemsTilesScaleZxyByScaleError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicItemsTilesScaleZxyByScale =
  Binding.Service<GetMosaicItemsTilesScaleZxyByScale>(
    "Azure.PlanetaryComputer.GetMosaicItemsTilesScaleZxyByScale",
  );
