import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `ReplaceStacQueryable` request without `endpoint`, which the bound GeoCatalog
 * (its `catalogUri`) supplies.
 */
export interface ReplaceStacQueryableRequest extends Omit<
  geocatalog.ReplaceStacQueryableRequest,
  "endpoint"
> {}

/**
 * Update Collection Queryables Updates a queryable given a queryable definition
 * and corresponding collection id.
 *
 * Binding assigns the built-in **GeoCatalog Administrator** role on the bound
 * catalog only: the only role the GeoCatalog data plane accepts for writes
 * (`Microsoft.Orbital` has no data actions, so no narrower custom role exists).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link ReplaceStacQueryableHttp}.
 *
 * ### Calling ReplaceStacQueryable
 * **Example:** ReplaceStacQueryable from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const replaceStacQueryable = yield* Azure.PlanetaryComputer.ReplaceStacQueryable(catalog);
 *
 * // runtime
 * const result = yield* replaceStacQueryable(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.ReplaceStacQueryableHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface ReplaceStacQueryable extends Binding.Service<
  ReplaceStacQueryable,
  "Azure.PlanetaryComputer.ReplaceStacQueryable",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: ReplaceStacQueryableRequest,
    ) => Effect.Effect<
      geocatalog.StacQueryable,
      geocatalog.ReplaceStacQueryableError,
      RuntimeContext
    >
  >
> {}

export const ReplaceStacQueryable = Binding.Service<ReplaceStacQueryable>(
  "Azure.PlanetaryComputer.ReplaceStacQueryable",
);
