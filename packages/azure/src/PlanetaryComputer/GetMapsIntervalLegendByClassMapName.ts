import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMapsIntervalLegendByClassMapName` request without `endpoint`, which the
 * bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMapsIntervalLegendByClassMapNameRequest extends Omit<
  geocatalog.GetMapsIntervalLegendByClassMapNameRequest,
  "endpoint"
> {}

/**
 * Get Interval Legend Generate values and color swatches mapping for a given
 * interval classmap.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMapsIntervalLegendByClassMapNameHttp}.
 *
 * ### Calling GetMapsIntervalLegendByClassMapName
 * **Example:** GetMapsIntervalLegendByClassMapName from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMapsIntervalLegendByClassMapName = yield* Azure.PlanetaryComputer.GetMapsIntervalLegendByClassMapName(catalog);
 *
 * // runtime
 * const result = yield* getMapsIntervalLegendByClassMapName(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMapsIntervalLegendByClassMapNameHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMapsIntervalLegendByClassMapName extends Binding.Service<
  GetMapsIntervalLegendByClassMapName,
  "Azure.PlanetaryComputer.GetMapsIntervalLegendByClassMapName",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMapsIntervalLegendByClassMapNameRequest,
    ) => Effect.Effect<
      geocatalog.GetMapsIntervalLegendByClassMapNameResponse,
      geocatalog.GetMapsIntervalLegendByClassMapNameError,
      RuntimeContext
    >
  >
> {}

export const GetMapsIntervalLegendByClassMapName =
  Binding.Service<GetMapsIntervalLegendByClassMapName>(
    "Azure.PlanetaryComputer.GetMapsIntervalLegendByClassMapName",
  );
