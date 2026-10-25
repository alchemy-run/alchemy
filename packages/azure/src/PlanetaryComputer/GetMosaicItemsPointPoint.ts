import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicItemsPointPoint` request without `endpoint`, which the bound
 * GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicItemsPointPointRequest extends Omit<
  geocatalog.GetMosaicItemsPointPointRequest,
  "endpoint"
> {}

/**
 * Item Point Get point value for a STAC item dataset.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicItemsPointPointHttp}.
 *
 * ### Calling GetMosaicItemsPointPoint
 * **Example:** GetMosaicItemsPointPoint from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicItemsPointPoint = yield* Azure.PlanetaryComputer.GetMosaicItemsPointPoint(catalog);
 *
 * // runtime
 * const result = yield* getMosaicItemsPointPoint(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicItemsPointPointHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicItemsPointPoint extends Binding.Service<
  GetMosaicItemsPointPoint,
  "Azure.PlanetaryComputer.GetMosaicItemsPointPoint",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicItemsPointPointRequest,
    ) => Effect.Effect<
      geocatalog.TilerCoreModelsResponsesPoint,
      geocatalog.GetMosaicItemsPointPointError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicItemsPointPoint = Binding.Service<GetMosaicItemsPointPoint>(
  "Azure.PlanetaryComputer.GetMosaicItemsPointPoint",
);
