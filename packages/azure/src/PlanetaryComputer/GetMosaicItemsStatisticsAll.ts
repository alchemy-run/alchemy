import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicItemsStatisticsAll` request without `endpoint`, which the bound
 * GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicItemsStatisticsAllRequest extends Omit<
  geocatalog.GetMosaicItemsStatisticsAllRequest,
  "endpoint"
> {}

/**
 * Item Statistics Merged assets statistics for a STAC item.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicItemsStatisticsAllHttp}.
 *
 * ### Calling GetMosaicItemsStatisticsAll
 * **Example:** GetMosaicItemsStatisticsAll from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicItemsStatisticsAll = yield* Azure.PlanetaryComputer.GetMosaicItemsStatisticsAll(catalog);
 *
 * // runtime
 * const result = yield* getMosaicItemsStatisticsAll(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicItemsStatisticsAllHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicItemsStatisticsAll extends Binding.Service<
  GetMosaicItemsStatisticsAll,
  "Azure.PlanetaryComputer.GetMosaicItemsStatisticsAll",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicItemsStatisticsAllRequest,
    ) => Effect.Effect<
      geocatalog.GetMosaicItemsStatisticsAllResponse,
      geocatalog.GetMosaicItemsStatisticsAllError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicItemsStatisticsAll = Binding.Service<GetMosaicItemsStatisticsAll>(
  "Azure.PlanetaryComputer.GetMosaicItemsStatisticsAll",
);
