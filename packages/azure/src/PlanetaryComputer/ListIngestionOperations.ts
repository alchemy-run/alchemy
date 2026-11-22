import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `ListIngestionOperations` request without `endpoint`, which the bound
 * GeoCatalog (its `catalogUri`) supplies.
 */
export interface ListIngestionOperationsRequest extends Omit<
  geocatalog.ListIngestionOperationsRequest,
  "endpoint"
> {}

/**
 * Get operations of a geo-catalog collection. One page per call: pass
 * `nextLink` for the next.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link ListIngestionOperationsHttp}.
 *
 * ### Calling ListIngestionOperations
 * **Example:** ListIngestionOperations from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const listIngestionOperations = yield* Azure.PlanetaryComputer.ListIngestionOperations(catalog);
 *
 * // runtime
 * const result = yield* listIngestionOperations();
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.ListIngestionOperationsHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface ListIngestionOperations extends Binding.Service<
  ListIngestionOperations,
  "Azure.PlanetaryComputer.ListIngestionOperations",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request?: ListIngestionOperationsRequest,
    ) => Effect.Effect<
      geocatalog.OperationPagedResponse,
      geocatalog.ListIngestionOperationsError,
      RuntimeContext
    >
  >
> {}

export const ListIngestionOperations = Binding.Service<ListIngestionOperations>(
  "Azure.PlanetaryComputer.ListIngestionOperations",
);
