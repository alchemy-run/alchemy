import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicItemsInfoGeoJson` request without `endpoint`, which the bound
 * GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicItemsInfoGeoJsonRequest extends Omit<
  geocatalog.GetMosaicItemsInfoGeoJsonRequest,
  "endpoint"
> {}

/**
 * Item Info Geojson Return info as GeoJSON for a STAC item.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicItemsInfoGeoJsonHttp}.
 *
 * ### Calling GetMosaicItemsInfoGeoJson
 * **Example:** GetMosaicItemsInfoGeoJson from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicItemsInfoGeoJson = yield* Azure.PlanetaryComputer.GetMosaicItemsInfoGeoJson(catalog);
 *
 * // runtime
 * const result = yield* getMosaicItemsInfoGeoJson(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicItemsInfoGeoJsonHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicItemsInfoGeoJson extends Binding.Service<
  GetMosaicItemsInfoGeoJson,
  "Azure.PlanetaryComputer.GetMosaicItemsInfoGeoJson",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicItemsInfoGeoJsonRequest,
    ) => Effect.Effect<
      geocatalog.TilerInfoGeoJsonFeature,
      geocatalog.GetMosaicItemsInfoGeoJsonError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicItemsInfoGeoJson = Binding.Service<GetMosaicItemsInfoGeoJson>(
  "Azure.PlanetaryComputer.GetMosaicItemsInfoGeoJson",
);
