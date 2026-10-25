import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicSearchesTilesPlainZxy` request without `endpoint`, which the bound
 * GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicSearchesTilesPlainZxyRequest extends Omit<
  geocatalog.GetMosaicSearchesTilesPlainZxyRequest,
  "endpoint"
> {}

/**
 * Searches Tile Plain The most basic operation.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicSearchesTilesPlainZxyHttp}.
 *
 * ### Calling GetMosaicSearchesTilesPlainZxy
 * **Example:** GetMosaicSearchesTilesPlainZxy from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicSearchesTilesPlainZxy = yield* Azure.PlanetaryComputer.GetMosaicSearchesTilesPlainZxy(catalog);
 *
 * // runtime
 * const result = yield* getMosaicSearchesTilesPlainZxy(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicSearchesTilesPlainZxyHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicSearchesTilesPlainZxy extends Binding.Service<
  GetMosaicSearchesTilesPlainZxy,
  "Azure.PlanetaryComputer.GetMosaicSearchesTilesPlainZxy",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicSearchesTilesPlainZxyRequest,
    ) => Effect.Effect<
      geocatalog.GetMosaicSearchesTilesPlainZxyResponse,
      geocatalog.GetMosaicSearchesTilesPlainZxyError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicSearchesTilesPlainZxy = Binding.Service<GetMosaicSearchesTilesPlainZxy>(
  "Azure.PlanetaryComputer.GetMosaicSearchesTilesPlainZxy",
);
