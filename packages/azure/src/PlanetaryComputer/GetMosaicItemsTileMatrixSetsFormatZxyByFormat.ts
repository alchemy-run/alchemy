import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicItemsTileMatrixSetsFormatZxyByFormat` request without `endpoint`,
 * which the bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicItemsTileMatrixSetsFormatZxyByFormatRequest extends Omit<
  geocatalog.GetMosaicItemsTileMatrixSetsFormatZxyByFormatRequest,
  "endpoint"
> {}

/**
 * Tile Tilematrixsetid Format Create map tile from a dataset (with format in
 * path, without scale).
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicItemsTileMatrixSetsFormatZxyByFormatHttp}.
 *
 * ### Calling GetMosaicItemsTileMatrixSetsFormatZxyByFormat
 * **Example:** GetMosaicItemsTileMatrixSetsFormatZxyByFormat from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicItemsTileMatrixSetsFormatZxyByFormat = yield* Azure.PlanetaryComputer.GetMosaicItemsTileMatrixSetsFormatZxyByFormat(catalog);
 *
 * // runtime
 * const result = yield* getMosaicItemsTileMatrixSetsFormatZxyByFormat(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicItemsTileMatrixSetsFormatZxyByFormatHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicItemsTileMatrixSetsFormatZxyByFormat extends Binding.Service<
  GetMosaicItemsTileMatrixSetsFormatZxyByFormat,
  "Azure.PlanetaryComputer.GetMosaicItemsTileMatrixSetsFormatZxyByFormat",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicItemsTileMatrixSetsFormatZxyByFormatRequest,
    ) => Effect.Effect<
      geocatalog.GetMosaicItemsTileMatrixSetsFormatZxyByFormatResponse,
      geocatalog.GetMosaicItemsTileMatrixSetsFormatZxyByFormatError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicItemsTileMatrixSetsFormatZxyByFormat =
  Binding.Service<GetMosaicItemsTileMatrixSetsFormatZxyByFormat>(
    "Azure.PlanetaryComputer.GetMosaicItemsTileMatrixSetsFormatZxyByFormat",
  );
