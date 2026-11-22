import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `MosaicSearchesFeatureGeoJsonFormatCropFormat` request without `endpoint`,
 * which the bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface MosaicSearchesFeatureGeoJsonFormatCropFormatRequest extends Omit<
  geocatalog.MosaicSearchesFeatureGeoJsonFormatCropFormatRequest,
  "endpoint"
> {}

/**
 * Searches Geojson Feature Crop With Format Create image from a geojson feature
 * with format.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link MosaicSearchesFeatureGeoJsonFormatCropFormatHttp}.
 *
 * ### Calling MosaicSearchesFeatureGeoJsonFormatCropFormat
 * **Example:** MosaicSearchesFeatureGeoJsonFormatCropFormat from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const mosaicSearchesFeatureGeoJsonFormatCropFormat = yield* Azure.PlanetaryComputer.MosaicSearchesFeatureGeoJsonFormatCropFormat(catalog);
 *
 * // runtime
 * const result = yield* mosaicSearchesFeatureGeoJsonFormatCropFormat(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.MosaicSearchesFeatureGeoJsonFormatCropFormatHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface MosaicSearchesFeatureGeoJsonFormatCropFormat extends Binding.Service<
  MosaicSearchesFeatureGeoJsonFormatCropFormat,
  "Azure.PlanetaryComputer.MosaicSearchesFeatureGeoJsonFormatCropFormat",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: MosaicSearchesFeatureGeoJsonFormatCropFormatRequest,
    ) => Effect.Effect<
      geocatalog.MosaicSearchesFeatureGeoJsonFormatCropFormatResponse,
      geocatalog.MosaicSearchesFeatureGeoJsonFormatCropFormatError,
      RuntimeContext
    >
  >
> {}

export const MosaicSearchesFeatureGeoJsonFormatCropFormat =
  Binding.Service<MosaicSearchesFeatureGeoJsonFormatCropFormat>(
    "Azure.PlanetaryComputer.MosaicSearchesFeatureGeoJsonFormatCropFormat",
  );
