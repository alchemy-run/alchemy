import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `MosaicItemsFeatureGeoJsonFormatCropFormat` request without `endpoint`, which
 * the bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface MosaicItemsFeatureGeoJsonFormatCropFormatRequest extends Omit<
  geocatalog.MosaicItemsFeatureGeoJsonFormatCropFormatRequest,
  "endpoint"
> {}

/**
 * Geojson Feature Crop With Format Create image from a geojson feature with
 * format.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link MosaicItemsFeatureGeoJsonFormatCropFormatHttp}.
 *
 * ### Calling MosaicItemsFeatureGeoJsonFormatCropFormat
 * **Example:** MosaicItemsFeatureGeoJsonFormatCropFormat from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const mosaicItemsFeatureGeoJsonFormatCropFormat = yield* Azure.PlanetaryComputer.MosaicItemsFeatureGeoJsonFormatCropFormat(catalog);
 *
 * // runtime
 * const result = yield* mosaicItemsFeatureGeoJsonFormatCropFormat(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.MosaicItemsFeatureGeoJsonFormatCropFormatHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface MosaicItemsFeatureGeoJsonFormatCropFormat extends Binding.Service<
  MosaicItemsFeatureGeoJsonFormatCropFormat,
  "Azure.PlanetaryComputer.MosaicItemsFeatureGeoJsonFormatCropFormat",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: MosaicItemsFeatureGeoJsonFormatCropFormatRequest,
    ) => Effect.Effect<
      geocatalog.MosaicItemsFeatureGeoJsonFormatCropFormatResponse,
      geocatalog.MosaicItemsFeatureGeoJsonFormatCropFormatError,
      RuntimeContext
    >
  >
> {}

export const MosaicItemsFeatureGeoJsonFormatCropFormat =
  Binding.Service<MosaicItemsFeatureGeoJsonFormatCropFormat>(
    "Azure.PlanetaryComputer.MosaicItemsFeatureGeoJsonFormatCropFormat",
  );
