import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicItemsAssetStatisticsAll` request without `endpoint`, which the
 * bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicItemsAssetStatisticsAllRequest extends Omit<
  geocatalog.GetMosaicItemsAssetStatisticsAllRequest,
  "endpoint"
> {}

/**
 * Item Asset Statistics Per asset statistics for a STAC item.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicItemsAssetStatisticsAllHttp}.
 *
 * ### Calling GetMosaicItemsAssetStatisticsAll
 * **Example:** GetMosaicItemsAssetStatisticsAll from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicItemsAssetStatisticsAll = yield* Azure.PlanetaryComputer.GetMosaicItemsAssetStatisticsAll(catalog);
 *
 * // runtime
 * const result = yield* getMosaicItemsAssetStatisticsAll(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicItemsAssetStatisticsAllHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicItemsAssetStatisticsAll extends Binding.Service<
  GetMosaicItemsAssetStatisticsAll,
  "Azure.PlanetaryComputer.GetMosaicItemsAssetStatisticsAll",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicItemsAssetStatisticsAllRequest,
    ) => Effect.Effect<
      geocatalog.GetMosaicItemsAssetStatisticsAllResponse,
      geocatalog.GetMosaicItemsAssetStatisticsAllError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicItemsAssetStatisticsAll = Binding.Service<GetMosaicItemsAssetStatisticsAll>(
  "Azure.PlanetaryComputer.GetMosaicItemsAssetStatisticsAll",
);
