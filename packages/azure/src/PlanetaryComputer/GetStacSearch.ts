import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetStacSearch` request without `endpoint`, which the bound GeoCatalog (its
 * `catalogUri`) supplies.
 */
export interface GetStacSearchRequest extends Omit<geocatalog.GetStacSearchRequest, "endpoint"> {}

/**
 * Search STAC search operation with query parameters.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetStacSearchHttp}.
 *
 * ### Calling GetStacSearch
 * **Example:** GetStacSearch from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getStacSearch = yield* Azure.PlanetaryComputer.GetStacSearch(catalog);
 *
 * // runtime
 * const result = yield* getStacSearch();
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetStacSearchHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetStacSearch extends Binding.Service<
  GetStacSearch,
  "Azure.PlanetaryComputer.GetStacSearch",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request?: GetStacSearchRequest,
    ) => Effect.Effect<
      geocatalog.GetStacSearchResponse,
      geocatalog.GetStacSearchError,
      RuntimeContext
    >
  >
> {}

export const GetStacSearch = Binding.Service<GetStacSearch>(
  "Azure.PlanetaryComputer.GetStacSearch",
);
