import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `MosaicItemsFeatureGeoJsonCrop` request without `endpoint`, which the bound
 * GeoCatalog (its `catalogUri`) supplies.
 */
export interface MosaicItemsFeatureGeoJsonCropRequest extends Omit<
  geocatalog.MosaicItemsFeatureGeoJsonCropRequest,
  "endpoint"
> {}

/**
 * Geojson Feature Create image from a geojson feature (without format in path).
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link MosaicItemsFeatureGeoJsonCropHttp}.
 *
 * ### Calling MosaicItemsFeatureGeoJsonCrop
 * **Example:** MosaicItemsFeatureGeoJsonCrop from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const mosaicItemsFeatureGeoJsonCrop = yield* Azure.PlanetaryComputer.MosaicItemsFeatureGeoJsonCrop(catalog);
 *
 * // runtime
 * const result = yield* mosaicItemsFeatureGeoJsonCrop(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.MosaicItemsFeatureGeoJsonCropHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface MosaicItemsFeatureGeoJsonCrop extends Binding.Service<
  MosaicItemsFeatureGeoJsonCrop,
  "Azure.PlanetaryComputer.MosaicItemsFeatureGeoJsonCrop",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: MosaicItemsFeatureGeoJsonCropRequest,
    ) => Effect.Effect<
      geocatalog.MosaicItemsFeatureGeoJsonCropResponse,
      geocatalog.MosaicItemsFeatureGeoJsonCropError,
      RuntimeContext
    >
  >
> {}

export const MosaicItemsFeatureGeoJsonCrop = Binding.Service<MosaicItemsFeatureGeoJsonCrop>(
  "Azure.PlanetaryComputer.MosaicItemsFeatureGeoJsonCrop",
);
