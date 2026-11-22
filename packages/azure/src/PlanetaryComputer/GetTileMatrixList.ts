import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetTileMatrixList` request without `endpoint`, which the bound GeoCatalog
 * (its `catalogUri`) supplies.
 */
export interface GetTileMatrixListRequest extends Omit<
  geocatalog.GetTileMatrixListRequest,
  "endpoint"
> {}

/**
 * Matrix List Return Matrix List.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetTileMatrixListHttp}.
 *
 * ### Calling GetTileMatrixList
 * **Example:** GetTileMatrixList from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getTileMatrixList = yield* Azure.PlanetaryComputer.GetTileMatrixList(catalog);
 *
 * // runtime
 * const result = yield* getTileMatrixList();
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetTileMatrixListHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetTileMatrixList extends Binding.Service<
  GetTileMatrixList,
  "Azure.PlanetaryComputer.GetTileMatrixList",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request?: GetTileMatrixListRequest,
    ) => Effect.Effect<
      geocatalog.GetTileMatrixListResponse,
      geocatalog.GetTileMatrixListError,
      RuntimeContext
    >
  >
> {}

export const GetTileMatrixList = Binding.Service<GetTileMatrixList>(
  "Azure.PlanetaryComputer.GetTileMatrixList",
);
