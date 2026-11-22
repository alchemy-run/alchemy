import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `CreateStacSearch` request without `endpoint`, which the bound GeoCatalog
 * (its `catalogUri`) supplies.
 */
export interface CreateStacSearchRequest extends Omit<
  geocatalog.CreateStacSearchRequest,
  "endpoint"
> {}

/**
 * Search the catalog's STAC items (`POST /stac/search`).
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link CreateStacSearchHttp}.
 *
 * ### Calling CreateStacSearch
 * **Example:** CreateStacSearch from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const createStacSearch = yield* Azure.PlanetaryComputer.CreateStacSearch(catalog);
 *
 * // runtime
 * const result = yield* createStacSearch({ collections: ["sentinel-2"], limit: 10 });
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.CreateStacSearchHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface CreateStacSearch extends Binding.Service<
  CreateStacSearch,
  "Azure.PlanetaryComputer.CreateStacSearch",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request?: CreateStacSearchRequest,
    ) => Effect.Effect<
      geocatalog.CreateStacSearchResponse,
      geocatalog.CreateStacSearchError,
      RuntimeContext
    >
  >
> {}

export const CreateStacSearch = Binding.Service<CreateStacSearch>(
  "Azure.PlanetaryComputer.CreateStacSearch",
);
