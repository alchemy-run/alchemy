import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicSearchesTilesFormatZxyByFormat` request without `endpoint`, which
 * the bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicSearchesTilesFormatZxyByFormatRequest extends Omit<
  geocatalog.GetMosaicSearchesTilesFormatZxyByFormatRequest,
  "endpoint"
> {}

/**
 * Searches Tile Format The most basic operation.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicSearchesTilesFormatZxyByFormatHttp}.
 *
 * ### Calling GetMosaicSearchesTilesFormatZxyByFormat
 * **Example:** GetMosaicSearchesTilesFormatZxyByFormat from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicSearchesTilesFormatZxyByFormat = yield* Azure.PlanetaryComputer.GetMosaicSearchesTilesFormatZxyByFormat(catalog);
 *
 * // runtime
 * const result = yield* getMosaicSearchesTilesFormatZxyByFormat(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicSearchesTilesFormatZxyByFormatHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicSearchesTilesFormatZxyByFormat extends Binding.Service<
  GetMosaicSearchesTilesFormatZxyByFormat,
  "Azure.PlanetaryComputer.GetMosaicSearchesTilesFormatZxyByFormat",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicSearchesTilesFormatZxyByFormatRequest,
    ) => Effect.Effect<
      geocatalog.GetMosaicSearchesTilesFormatZxyByFormatResponse,
      geocatalog.GetMosaicSearchesTilesFormatZxyByFormatError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicSearchesTilesFormatZxyByFormat =
  Binding.Service<GetMosaicSearchesTilesFormatZxyByFormat>(
    "Azure.PlanetaryComputer.GetMosaicSearchesTilesFormatZxyByFormat",
  );
