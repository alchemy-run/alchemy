import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicSearchesTileZxyScaleByFormat` request without `endpoint`, which the
 * bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicSearchesTileZxyScaleByFormatRequest extends Omit<
  geocatalog.GetMosaicSearchesTileZxyScaleByFormatRequest,
  "endpoint"
> {}

/**
 * Searches Tile The most basic operation.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicSearchesTileZxyScaleByFormatHttp}.
 *
 * ### Calling GetMosaicSearchesTileZxyScaleByFormat
 * **Example:** GetMosaicSearchesTileZxyScaleByFormat from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicSearchesTileZxyScaleByFormat = yield* Azure.PlanetaryComputer.GetMosaicSearchesTileZxyScaleByFormat(catalog);
 *
 * // runtime
 * const result = yield* getMosaicSearchesTileZxyScaleByFormat(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicSearchesTileZxyScaleByFormatHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicSearchesTileZxyScaleByFormat extends Binding.Service<
  GetMosaicSearchesTileZxyScaleByFormat,
  "Azure.PlanetaryComputer.GetMosaicSearchesTileZxyScaleByFormat",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicSearchesTileZxyScaleByFormatRequest,
    ) => Effect.Effect<
      geocatalog.GetMosaicSearchesTileZxyScaleByFormatResponse,
      geocatalog.GetMosaicSearchesTileZxyScaleByFormatError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicSearchesTileZxyScaleByFormat =
  Binding.Service<GetMosaicSearchesTileZxyScaleByFormat>(
    "Azure.PlanetaryComputer.GetMosaicSearchesTileZxyScaleByFormat",
  );
