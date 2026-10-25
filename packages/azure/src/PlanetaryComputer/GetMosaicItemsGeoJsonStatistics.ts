import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicItemsGeoJsonStatistics` request without `endpoint`, which the bound
 * GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicItemsGeoJsonStatisticsRequest extends Omit<
  geocatalog.GetMosaicItemsGeoJsonStatisticsRequest,
  "endpoint"
> {}

/**
 * Item Geojson Statistics Get statistics from a GeoJSON feature for a STAC
 * item.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicItemsGeoJsonStatisticsHttp}.
 *
 * ### Calling GetMosaicItemsGeoJsonStatistics
 * **Example:** GetMosaicItemsGeoJsonStatistics from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicItemsGeoJsonStatistics = yield* Azure.PlanetaryComputer.GetMosaicItemsGeoJsonStatistics(catalog);
 *
 * // runtime
 * const result = yield* getMosaicItemsGeoJsonStatistics(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicItemsGeoJsonStatisticsHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicItemsGeoJsonStatistics extends Binding.Service<
  GetMosaicItemsGeoJsonStatistics,
  "Azure.PlanetaryComputer.GetMosaicItemsGeoJsonStatistics",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicItemsGeoJsonStatisticsRequest,
    ) => Effect.Effect<
      geocatalog.StacItemStatisticsGeoJson,
      geocatalog.GetMosaicItemsGeoJsonStatisticsError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicItemsGeoJsonStatistics = Binding.Service<GetMosaicItemsGeoJsonStatistics>(
  "Azure.PlanetaryComputer.GetMosaicItemsGeoJsonStatistics",
);
