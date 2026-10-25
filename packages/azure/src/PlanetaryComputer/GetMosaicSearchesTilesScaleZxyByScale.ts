import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicSearchesTilesScaleZxyByScale` request without `endpoint`, which the
 * bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicSearchesTilesScaleZxyByScaleRequest extends Omit<
  geocatalog.GetMosaicSearchesTilesScaleZxyByScaleRequest,
  "endpoint"
> {}

/**
 * Searches Tile Scale The most basic operation.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicSearchesTilesScaleZxyByScaleHttp}.
 *
 * ### Calling GetMosaicSearchesTilesScaleZxyByScale
 * **Example:** GetMosaicSearchesTilesScaleZxyByScale from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicSearchesTilesScaleZxyByScale = yield* Azure.PlanetaryComputer.GetMosaicSearchesTilesScaleZxyByScale(catalog);
 *
 * // runtime
 * const result = yield* getMosaicSearchesTilesScaleZxyByScale(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicSearchesTilesScaleZxyByScaleHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicSearchesTilesScaleZxyByScale extends Binding.Service<
  GetMosaicSearchesTilesScaleZxyByScale,
  "Azure.PlanetaryComputer.GetMosaicSearchesTilesScaleZxyByScale",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicSearchesTilesScaleZxyByScaleRequest,
    ) => Effect.Effect<
      geocatalog.GetMosaicSearchesTilesScaleZxyByScaleResponse,
      geocatalog.GetMosaicSearchesTilesScaleZxyByScaleError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicSearchesTilesScaleZxyByScale =
  Binding.Service<GetMosaicSearchesTilesScaleZxyByScale>(
    "Azure.PlanetaryComputer.GetMosaicSearchesTilesScaleZxyByScale",
  );
