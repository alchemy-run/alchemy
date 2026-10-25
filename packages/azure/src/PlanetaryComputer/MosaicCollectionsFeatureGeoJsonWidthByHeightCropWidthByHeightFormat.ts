import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `MosaicCollectionsFeatureGeoJsonWidthByHeightCropWidthByHeightFormat` request
 * without `endpoint`, which the bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface MosaicCollectionsFeatureGeoJsonWidthByHeightCropWidthByHeightFormatRequest extends Omit<
  geocatalog.MosaicCollectionsFeatureGeoJsonWidthByHeightCropWidthByHeightFormatRequest,
  "endpoint"
> {}

/**
 * Collection Geojson Feature Crop With Dimensions Create image from a geojson
 * feature with dimensions.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link MosaicCollectionsFeatureGeoJsonWidthByHeightCropWidthByHeightFormatHttp}.
 *
 * ### Calling MosaicCollectionsFeatureGeoJsonWidthByHeightCropWidthByHeightFormat
 * **Example:** MosaicCollectionsFeatureGeoJsonWidthByHeightCropWidthByHeightFormat from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const mosaicCollectionsFeatureGeoJsonWidthByHeightCropWidthByHeightFormat = yield* Azure.PlanetaryComputer.MosaicCollectionsFeatureGeoJsonWidthByHeightCropWidthByHeightFormat(catalog);
 *
 * // runtime
 * const result = yield* mosaicCollectionsFeatureGeoJsonWidthByHeightCropWidthByHeightFormat(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.MosaicCollectionsFeatureGeoJsonWidthByHeightCropWidthByHeightFormatHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface MosaicCollectionsFeatureGeoJsonWidthByHeightCropWidthByHeightFormat extends Binding.Service<
  MosaicCollectionsFeatureGeoJsonWidthByHeightCropWidthByHeightFormat,
  "Azure.PlanetaryComputer.MosaicCollectionsFeatureGeoJsonWidthByHeightCropWidthByHeightFormat",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: MosaicCollectionsFeatureGeoJsonWidthByHeightCropWidthByHeightFormatRequest,
    ) => Effect.Effect<
      geocatalog.MosaicCollectionsFeatureGeoJsonWidthByHeightCropWidthByHeightFormatResponse,
      geocatalog.MosaicCollectionsFeatureGeoJsonWidthByHeightCropWidthByHeightFormatError,
      RuntimeContext
    >
  >
> {}

export const MosaicCollectionsFeatureGeoJsonWidthByHeightCropWidthByHeightFormat =
  Binding.Service<MosaicCollectionsFeatureGeoJsonWidthByHeightCropWidthByHeightFormat>(
    "Azure.PlanetaryComputer.MosaicCollectionsFeatureGeoJsonWidthByHeightCropWidthByHeightFormat",
  );
