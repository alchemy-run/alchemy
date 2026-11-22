import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `MosaicSearchesFeatureGeoJsonWidthByHeightCropWidthByHeightFormat` request
 * without `endpoint`, which the bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface MosaicSearchesFeatureGeoJsonWidthByHeightCropWidthByHeightFormatRequest extends Omit<
  geocatalog.MosaicSearchesFeatureGeoJsonWidthByHeightCropWidthByHeightFormatRequest,
  "endpoint"
> {}

/**
 * Searches Geojson Feature Crop With Dimensions Create image from a geojson
 * feature with dimensions.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link MosaicSearchesFeatureGeoJsonWidthByHeightCropWidthByHeightFormatHttp}.
 *
 * ### Calling MosaicSearchesFeatureGeoJsonWidthByHeightCropWidthByHeightFormat
 * **Example:** MosaicSearchesFeatureGeoJsonWidthByHeightCropWidthByHeightFormat from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const mosaicSearchesFeatureGeoJsonWidthByHeightCropWidthByHeightFormat = yield* Azure.PlanetaryComputer.MosaicSearchesFeatureGeoJsonWidthByHeightCropWidthByHeightFormat(catalog);
 *
 * // runtime
 * const result = yield* mosaicSearchesFeatureGeoJsonWidthByHeightCropWidthByHeightFormat(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.MosaicSearchesFeatureGeoJsonWidthByHeightCropWidthByHeightFormatHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface MosaicSearchesFeatureGeoJsonWidthByHeightCropWidthByHeightFormat extends Binding.Service<
  MosaicSearchesFeatureGeoJsonWidthByHeightCropWidthByHeightFormat,
  "Azure.PlanetaryComputer.MosaicSearchesFeatureGeoJsonWidthByHeightCropWidthByHeightFormat",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: MosaicSearchesFeatureGeoJsonWidthByHeightCropWidthByHeightFormatRequest,
    ) => Effect.Effect<
      geocatalog.MosaicSearchesFeatureGeoJsonWidthByHeightCropWidthByHeightFormatResponse,
      geocatalog.MosaicSearchesFeatureGeoJsonWidthByHeightCropWidthByHeightFormatError,
      RuntimeContext
    >
  >
> {}

export const MosaicSearchesFeatureGeoJsonWidthByHeightCropWidthByHeightFormat =
  Binding.Service<MosaicSearchesFeatureGeoJsonWidthByHeightCropWidthByHeightFormat>(
    "Azure.PlanetaryComputer.MosaicSearchesFeatureGeoJsonWidthByHeightCropWidthByHeightFormat",
  );
