import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetStacQueryableAll` request without `endpoint`, which the bound GeoCatalog
 * (its `catalogUri`) supplies.
 */
export interface GetStacQueryableAllRequest extends Omit<
  geocatalog.GetStacQueryableAllRequest,
  "endpoint"
> {}

/**
 * Queryables List all queryables in the GeoCatalog instance.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetStacQueryableAllHttp}.
 *
 * ### Calling GetStacQueryableAll
 * **Example:** GetStacQueryableAll from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getStacQueryableAll = yield* Azure.PlanetaryComputer.GetStacQueryableAll(catalog);
 *
 * // runtime
 * const result = yield* getStacQueryableAll();
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetStacQueryableAllHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetStacQueryableAll extends Binding.Service<
  GetStacQueryableAll,
  "Azure.PlanetaryComputer.GetStacQueryableAll",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request?: GetStacQueryableAllRequest,
    ) => Effect.Effect<
      geocatalog.GetStacQueryableAllResponse,
      geocatalog.GetStacQueryableAllError,
      RuntimeContext
    >
  >
> {}

export const GetStacQueryableAll = Binding.Service<GetStacQueryableAll>(
  "Azure.PlanetaryComputer.GetStacQueryableAll",
);
