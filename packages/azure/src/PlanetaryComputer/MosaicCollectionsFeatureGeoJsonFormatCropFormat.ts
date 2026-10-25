import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `MosaicCollectionsFeatureGeoJsonFormatCropFormat` request without `endpoint`,
 * which the bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface MosaicCollectionsFeatureGeoJsonFormatCropFormatRequest extends Omit<
  geocatalog.MosaicCollectionsFeatureGeoJsonFormatCropFormatRequest,
  "endpoint"
> {}

/**
 * Collection Geojson Feature Crop With Format Create image from a geojson
 * feature with format.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link MosaicCollectionsFeatureGeoJsonFormatCropFormatHttp}.
 *
 * ### Calling MosaicCollectionsFeatureGeoJsonFormatCropFormat
 * **Example:** MosaicCollectionsFeatureGeoJsonFormatCropFormat from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const mosaicCollectionsFeatureGeoJsonFormatCropFormat = yield* Azure.PlanetaryComputer.MosaicCollectionsFeatureGeoJsonFormatCropFormat(catalog);
 *
 * // runtime
 * const result = yield* mosaicCollectionsFeatureGeoJsonFormatCropFormat(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.MosaicCollectionsFeatureGeoJsonFormatCropFormatHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface MosaicCollectionsFeatureGeoJsonFormatCropFormat extends Binding.Service<
  MosaicCollectionsFeatureGeoJsonFormatCropFormat,
  "Azure.PlanetaryComputer.MosaicCollectionsFeatureGeoJsonFormatCropFormat",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: MosaicCollectionsFeatureGeoJsonFormatCropFormatRequest,
    ) => Effect.Effect<
      geocatalog.MosaicCollectionsFeatureGeoJsonFormatCropFormatResponse,
      geocatalog.MosaicCollectionsFeatureGeoJsonFormatCropFormatError,
      RuntimeContext
    >
  >
> {}

export const MosaicCollectionsFeatureGeoJsonFormatCropFormat =
  Binding.Service<MosaicCollectionsFeatureGeoJsonFormatCropFormat>(
    "Azure.PlanetaryComputer.MosaicCollectionsFeatureGeoJsonFormatCropFormat",
  );
