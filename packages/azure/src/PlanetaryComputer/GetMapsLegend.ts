import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMapsLegend` request without `endpoint`, which the bound GeoCatalog (its
 * `catalogUri`) supplies.
 */
export interface GetMapsLegendRequest extends Omit<geocatalog.GetMapsLegendRequest, "endpoint"> {}

/**
 * Get Legend Generate a legend image for a given colormap.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMapsLegendHttp}.
 *
 * ### Calling GetMapsLegend
 * **Example:** GetMapsLegend from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMapsLegend = yield* Azure.PlanetaryComputer.GetMapsLegend(catalog);
 *
 * // runtime
 * const result = yield* getMapsLegend(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMapsLegendHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMapsLegend extends Binding.Service<
  GetMapsLegend,
  "Azure.PlanetaryComputer.GetMapsLegend",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMapsLegendRequest,
    ) => Effect.Effect<
      geocatalog.GetMapsLegendResponse,
      geocatalog.GetMapsLegendError,
      RuntimeContext
    >
  >
> {}

export const GetMapsLegend = Binding.Service<GetMapsLegend>(
  "Azure.PlanetaryComputer.GetMapsLegend",
);
