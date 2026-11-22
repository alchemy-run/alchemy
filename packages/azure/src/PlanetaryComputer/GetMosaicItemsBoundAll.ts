import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicItemsBoundAll` request without `endpoint`, which the bound
 * GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicItemsBoundAllRequest extends Omit<
  geocatalog.GetMosaicItemsBoundAllRequest,
  "endpoint"
> {}

/**
 * Item Bounds Return the bounds for a STAC item.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicItemsBoundAllHttp}.
 *
 * ### Calling GetMosaicItemsBoundAll
 * **Example:** GetMosaicItemsBoundAll from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicItemsBoundAll = yield* Azure.PlanetaryComputer.GetMosaicItemsBoundAll(catalog);
 *
 * // runtime
 * const result = yield* getMosaicItemsBoundAll(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicItemsBoundAllHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicItemsBoundAll extends Binding.Service<
  GetMosaicItemsBoundAll,
  "Azure.PlanetaryComputer.GetMosaicItemsBoundAll",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicItemsBoundAllRequest,
    ) => Effect.Effect<
      geocatalog.StacItemBounds,
      geocatalog.GetMosaicItemsBoundAllError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicItemsBoundAll = Binding.Service<GetMosaicItemsBoundAll>(
  "Azure.PlanetaryComputer.GetMosaicItemsBoundAll",
);
