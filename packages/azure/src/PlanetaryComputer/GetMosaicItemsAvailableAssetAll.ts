import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicItemsAvailableAssetAll` request without `endpoint`, which the bound
 * GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicItemsAvailableAssetAllRequest extends Omit<
  geocatalog.GetMosaicItemsAvailableAssetAllRequest,
  "endpoint"
> {}

/**
 * Item Available Assets Return a list of supported assets for a STAC item.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicItemsAvailableAssetAllHttp}.
 *
 * ### Calling GetMosaicItemsAvailableAssetAll
 * **Example:** GetMosaicItemsAvailableAssetAll from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicItemsAvailableAssetAll = yield* Azure.PlanetaryComputer.GetMosaicItemsAvailableAssetAll(catalog);
 *
 * // runtime
 * const result = yield* getMosaicItemsAvailableAssetAll(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicItemsAvailableAssetAllHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicItemsAvailableAssetAll extends Binding.Service<
  GetMosaicItemsAvailableAssetAll,
  "Azure.PlanetaryComputer.GetMosaicItemsAvailableAssetAll",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicItemsAvailableAssetAllRequest,
    ) => Effect.Effect<
      geocatalog.GetMosaicItemsAvailableAssetAllResponse,
      geocatalog.GetMosaicItemsAvailableAssetAllError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicItemsAvailableAssetAll = Binding.Service<GetMosaicItemsAvailableAssetAll>(
  "Azure.PlanetaryComputer.GetMosaicItemsAvailableAssetAll",
);
