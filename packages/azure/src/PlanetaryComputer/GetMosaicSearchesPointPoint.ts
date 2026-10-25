import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicSearchesPointPoint` request without `endpoint`, which the bound
 * GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicSearchesPointPointRequest extends Omit<
  geocatalog.GetMosaicSearchesPointPointRequest,
  "endpoint"
> {}

/**
 * Searches Point Get Point value for a search dataset.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicSearchesPointPointHttp}.
 *
 * ### Calling GetMosaicSearchesPointPoint
 * **Example:** GetMosaicSearchesPointPoint from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicSearchesPointPoint = yield* Azure.PlanetaryComputer.GetMosaicSearchesPointPoint(catalog);
 *
 * // runtime
 * const result = yield* getMosaicSearchesPointPoint(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicSearchesPointPointHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicSearchesPointPoint extends Binding.Service<
  GetMosaicSearchesPointPoint,
  "Azure.PlanetaryComputer.GetMosaicSearchesPointPoint",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicSearchesPointPointRequest,
    ) => Effect.Effect<
      geocatalog.TilerCoreModelsResponsesPoint,
      geocatalog.GetMosaicSearchesPointPointError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicSearchesPointPoint = Binding.Service<GetMosaicSearchesPointPoint>(
  "Azure.PlanetaryComputer.GetMosaicSearchesPointPoint",
);
