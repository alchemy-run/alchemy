import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicItemsTileMatrixSetsScaleZxyByScale` request without `endpoint`,
 * which the bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicItemsTileMatrixSetsScaleZxyByScaleRequest extends Omit<
  geocatalog.GetMosaicItemsTileMatrixSetsScaleZxyByScaleRequest,
  "endpoint"
> {}

/**
 * Tile Tilematrixsetid Scale Create map tile from a dataset (with scale in
 * path, without format).
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicItemsTileMatrixSetsScaleZxyByScaleHttp}.
 *
 * ### Calling GetMosaicItemsTileMatrixSetsScaleZxyByScale
 * **Example:** GetMosaicItemsTileMatrixSetsScaleZxyByScale from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicItemsTileMatrixSetsScaleZxyByScale = yield* Azure.PlanetaryComputer.GetMosaicItemsTileMatrixSetsScaleZxyByScale(catalog);
 *
 * // runtime
 * const result = yield* getMosaicItemsTileMatrixSetsScaleZxyByScale(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicItemsTileMatrixSetsScaleZxyByScaleHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicItemsTileMatrixSetsScaleZxyByScale extends Binding.Service<
  GetMosaicItemsTileMatrixSetsScaleZxyByScale,
  "Azure.PlanetaryComputer.GetMosaicItemsTileMatrixSetsScaleZxyByScale",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicItemsTileMatrixSetsScaleZxyByScaleRequest,
    ) => Effect.Effect<
      geocatalog.GetMosaicItemsTileMatrixSetsScaleZxyByScaleResponse,
      geocatalog.GetMosaicItemsTileMatrixSetsScaleZxyByScaleError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicItemsTileMatrixSetsScaleZxyByScale =
  Binding.Service<GetMosaicItemsTileMatrixSetsScaleZxyByScale>(
    "Azure.PlanetaryComputer.GetMosaicItemsTileMatrixSetsScaleZxyByScale",
  );
