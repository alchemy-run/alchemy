import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetTileMatrixDefinition` request without `endpoint`, which the bound
 * GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetTileMatrixDefinitionRequest extends Omit<
  geocatalog.GetTileMatrixDefinitionRequest,
  "endpoint"
> {}

/**
 * Matrix Definition Return Matrix Definition.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetTileMatrixDefinitionHttp}.
 *
 * ### Calling GetTileMatrixDefinition
 * **Example:** GetTileMatrixDefinition from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getTileMatrixDefinition = yield* Azure.PlanetaryComputer.GetTileMatrixDefinition(catalog);
 *
 * // runtime
 * const result = yield* getTileMatrixDefinition(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetTileMatrixDefinitionHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetTileMatrixDefinition extends Binding.Service<
  GetTileMatrixDefinition,
  "Azure.PlanetaryComputer.GetTileMatrixDefinition",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetTileMatrixDefinitionRequest,
    ) => Effect.Effect<
      geocatalog.TileMatrixSet,
      geocatalog.GetTileMatrixDefinitionError,
      RuntimeContext
    >
  >
> {}

export const GetTileMatrixDefinition = Binding.Service<GetTileMatrixDefinition>(
  "Azure.PlanetaryComputer.GetTileMatrixDefinition",
);
