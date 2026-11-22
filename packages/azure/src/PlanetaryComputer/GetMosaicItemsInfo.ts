import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicItemsInfo` request without `endpoint`, which the bound GeoCatalog
 * (its `catalogUri`) supplies.
 */
export interface GetMosaicItemsInfoRequest extends Omit<
  geocatalog.GetMosaicItemsInfoRequest,
  "endpoint"
> {}

/**
 * Item Info Return dataset's basic info for a STAC item.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicItemsInfoHttp}.
 *
 * ### Calling GetMosaicItemsInfo
 * **Example:** GetMosaicItemsInfo from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicItemsInfo = yield* Azure.PlanetaryComputer.GetMosaicItemsInfo(catalog);
 *
 * // runtime
 * const result = yield* getMosaicItemsInfo(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicItemsInfoHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicItemsInfo extends Binding.Service<
  GetMosaicItemsInfo,
  "Azure.PlanetaryComputer.GetMosaicItemsInfo",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicItemsInfoRequest,
    ) => Effect.Effect<
      geocatalog.GetMosaicItemsInfoResponse,
      geocatalog.GetMosaicItemsInfoError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicItemsInfo = Binding.Service<GetMosaicItemsInfo>(
  "Azure.PlanetaryComputer.GetMosaicItemsInfo",
);
