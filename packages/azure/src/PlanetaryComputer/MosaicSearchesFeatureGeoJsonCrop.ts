import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `MosaicSearchesFeatureGeoJsonCrop` request without `endpoint`, which the
 * bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface MosaicSearchesFeatureGeoJsonCropRequest extends Omit<
  geocatalog.MosaicSearchesFeatureGeoJsonCropRequest,
  "endpoint"
> {}

/**
 * Searches Geojson Feature Create image from a geojson feature (without format
 * in path).
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link MosaicSearchesFeatureGeoJsonCropHttp}.
 *
 * ### Calling MosaicSearchesFeatureGeoJsonCrop
 * **Example:** MosaicSearchesFeatureGeoJsonCrop from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const mosaicSearchesFeatureGeoJsonCrop = yield* Azure.PlanetaryComputer.MosaicSearchesFeatureGeoJsonCrop(catalog);
 *
 * // runtime
 * const result = yield* mosaicSearchesFeatureGeoJsonCrop(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.MosaicSearchesFeatureGeoJsonCropHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface MosaicSearchesFeatureGeoJsonCrop extends Binding.Service<
  MosaicSearchesFeatureGeoJsonCrop,
  "Azure.PlanetaryComputer.MosaicSearchesFeatureGeoJsonCrop",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: MosaicSearchesFeatureGeoJsonCropRequest,
    ) => Effect.Effect<
      geocatalog.MosaicSearchesFeatureGeoJsonCropResponse,
      geocatalog.MosaicSearchesFeatureGeoJsonCropError,
      RuntimeContext
    >
  >
> {}

export const MosaicSearchesFeatureGeoJsonCrop = Binding.Service<MosaicSearchesFeatureGeoJsonCrop>(
  "Azure.PlanetaryComputer.MosaicSearchesFeatureGeoJsonCrop",
);
