import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `MosaicItemsFeatureGeoJsonWidthByHeightCropWidthByHeightFormat` request
 * without `endpoint`, which the bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface MosaicItemsFeatureGeoJsonWidthByHeightCropWidthByHeightFormatRequest extends Omit<
  geocatalog.MosaicItemsFeatureGeoJsonWidthByHeightCropWidthByHeightFormatRequest,
  "endpoint"
> {}

/**
 * Geojson Feature Crop With Dimensions Create image from a geojson feature with
 * dimensions.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link MosaicItemsFeatureGeoJsonWidthByHeightCropWidthByHeightFormatHttp}.
 *
 * ### Calling MosaicItemsFeatureGeoJsonWidthByHeightCropWidthByHeightFormat
 * **Example:** MosaicItemsFeatureGeoJsonWidthByHeightCropWidthByHeightFormat from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const mosaicItemsFeatureGeoJsonWidthByHeightCropWidthByHeightFormat = yield* Azure.PlanetaryComputer.MosaicItemsFeatureGeoJsonWidthByHeightCropWidthByHeightFormat(catalog);
 *
 * // runtime
 * const result = yield* mosaicItemsFeatureGeoJsonWidthByHeightCropWidthByHeightFormat(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.MosaicItemsFeatureGeoJsonWidthByHeightCropWidthByHeightFormatHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface MosaicItemsFeatureGeoJsonWidthByHeightCropWidthByHeightFormat extends Binding.Service<
  MosaicItemsFeatureGeoJsonWidthByHeightCropWidthByHeightFormat,
  "Azure.PlanetaryComputer.MosaicItemsFeatureGeoJsonWidthByHeightCropWidthByHeightFormat",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: MosaicItemsFeatureGeoJsonWidthByHeightCropWidthByHeightFormatRequest,
    ) => Effect.Effect<
      geocatalog.MosaicItemsFeatureGeoJsonWidthByHeightCropWidthByHeightFormatResponse,
      geocatalog.MosaicItemsFeatureGeoJsonWidthByHeightCropWidthByHeightFormatError,
      RuntimeContext
    >
  >
> {}

export const MosaicItemsFeatureGeoJsonWidthByHeightCropWidthByHeightFormat =
  Binding.Service<MosaicItemsFeatureGeoJsonWidthByHeightCropWidthByHeightFormat>(
    "Azure.PlanetaryComputer.MosaicItemsFeatureGeoJsonWidthByHeightCropWidthByHeightFormat",
  );
