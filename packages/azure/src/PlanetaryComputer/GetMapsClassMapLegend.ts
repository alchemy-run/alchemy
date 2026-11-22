import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMapsClassMapLegend` request without `endpoint`, which the bound
 * GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMapsClassMapLegendRequest extends Omit<
  geocatalog.GetMapsClassMapLegendRequest,
  "endpoint"
> {}

/**
 * Get ClassMap Legend Generate values and color swatches mapping for a given
 * classmap.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMapsClassMapLegendHttp}.
 *
 * ### Calling GetMapsClassMapLegend
 * **Example:** GetMapsClassMapLegend from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMapsClassMapLegend = yield* Azure.PlanetaryComputer.GetMapsClassMapLegend(catalog);
 *
 * // runtime
 * const result = yield* getMapsClassMapLegend(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMapsClassMapLegendHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMapsClassMapLegend extends Binding.Service<
  GetMapsClassMapLegend,
  "Azure.PlanetaryComputer.GetMapsClassMapLegend",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMapsClassMapLegendRequest,
    ) => Effect.Effect<
      geocatalog.GetMapsClassMapLegendResponse,
      geocatalog.GetMapsClassMapLegendError,
      RuntimeContext
    >
  >
> {}

export const GetMapsClassMapLegend = Binding.Service<GetMapsClassMapLegend>(
  "Azure.PlanetaryComputer.GetMapsClassMapLegend",
);
