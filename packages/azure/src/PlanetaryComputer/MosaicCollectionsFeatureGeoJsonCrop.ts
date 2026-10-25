import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `MosaicCollectionsFeatureGeoJsonCrop` request without `endpoint`, which the
 * bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface MosaicCollectionsFeatureGeoJsonCropRequest extends Omit<
  geocatalog.MosaicCollectionsFeatureGeoJsonCropRequest,
  "endpoint"
> {}

/**
 * Collection Geojson Feature Create image from a geojson feature (without
 * format in path).
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link MosaicCollectionsFeatureGeoJsonCropHttp}.
 *
 * ### Calling MosaicCollectionsFeatureGeoJsonCrop
 * **Example:** MosaicCollectionsFeatureGeoJsonCrop from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const mosaicCollectionsFeatureGeoJsonCrop = yield* Azure.PlanetaryComputer.MosaicCollectionsFeatureGeoJsonCrop(catalog);
 *
 * // runtime
 * const result = yield* mosaicCollectionsFeatureGeoJsonCrop(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.MosaicCollectionsFeatureGeoJsonCropHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface MosaicCollectionsFeatureGeoJsonCrop extends Binding.Service<
  MosaicCollectionsFeatureGeoJsonCrop,
  "Azure.PlanetaryComputer.MosaicCollectionsFeatureGeoJsonCrop",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: MosaicCollectionsFeatureGeoJsonCropRequest,
    ) => Effect.Effect<
      geocatalog.MosaicCollectionsFeatureGeoJsonCropResponse,
      geocatalog.MosaicCollectionsFeatureGeoJsonCropError,
      RuntimeContext
    >
  >
> {}

export const MosaicCollectionsFeatureGeoJsonCrop =
  Binding.Service<MosaicCollectionsFeatureGeoJsonCrop>(
    "Azure.PlanetaryComputer.MosaicCollectionsFeatureGeoJsonCrop",
  );
