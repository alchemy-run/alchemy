import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicItemsTilesScaleByFormatZxyScaleByFormat` request without
 * `endpoint`, which the bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicItemsTilesScaleByFormatZxyScaleByFormatRequest extends Omit<
  geocatalog.GetMosaicItemsTilesScaleByFormatZxyScaleByFormatRequest,
  "endpoint"
> {}

/**
 * Tile Create map tile from a dataset (with scale and format in path, without
 * TileMatrixSetId).
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicItemsTilesScaleByFormatZxyScaleByFormatHttp}.
 *
 * ### Calling GetMosaicItemsTilesScaleByFormatZxyScaleByFormat
 * **Example:** GetMosaicItemsTilesScaleByFormatZxyScaleByFormat from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicItemsTilesScaleByFormatZxyScaleByFormat = yield* Azure.PlanetaryComputer.GetMosaicItemsTilesScaleByFormatZxyScaleByFormat(catalog);
 *
 * // runtime
 * const result = yield* getMosaicItemsTilesScaleByFormatZxyScaleByFormat(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicItemsTilesScaleByFormatZxyScaleByFormatHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicItemsTilesScaleByFormatZxyScaleByFormat extends Binding.Service<
  GetMosaicItemsTilesScaleByFormatZxyScaleByFormat,
  "Azure.PlanetaryComputer.GetMosaicItemsTilesScaleByFormatZxyScaleByFormat",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicItemsTilesScaleByFormatZxyScaleByFormatRequest,
    ) => Effect.Effect<
      geocatalog.GetMosaicItemsTilesScaleByFormatZxyScaleByFormatResponse,
      geocatalog.GetMosaicItemsTilesScaleByFormatZxyScaleByFormatError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicItemsTilesScaleByFormatZxyScaleByFormat =
  Binding.Service<GetMosaicItemsTilesScaleByFormatZxyScaleByFormat>(
    "Azure.PlanetaryComputer.GetMosaicItemsTilesScaleByFormatZxyScaleByFormat",
  );
