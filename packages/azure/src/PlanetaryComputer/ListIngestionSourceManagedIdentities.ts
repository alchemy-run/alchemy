import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `ListIngestionSourceManagedIdentities` request without `endpoint`, which the
 * bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface ListIngestionSourceManagedIdentitiesRequest extends Omit<
  geocatalog.ListIngestionSourceManagedIdentitiesRequest,
  "endpoint"
> {}

/**
 * Get all managed identities with access to storage accounts configured for a
 * geo-catalog. One page per call: pass `nextLink` for the next.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link ListIngestionSourceManagedIdentitiesHttp}.
 *
 * ### Calling ListIngestionSourceManagedIdentities
 * **Example:** ListIngestionSourceManagedIdentities from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const listIngestionSourceManagedIdentities = yield* Azure.PlanetaryComputer.ListIngestionSourceManagedIdentities(catalog);
 *
 * // runtime
 * const result = yield* listIngestionSourceManagedIdentities();
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.ListIngestionSourceManagedIdentitiesHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface ListIngestionSourceManagedIdentities extends Binding.Service<
  ListIngestionSourceManagedIdentities,
  "Azure.PlanetaryComputer.ListIngestionSourceManagedIdentities",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request?: ListIngestionSourceManagedIdentitiesRequest,
    ) => Effect.Effect<
      geocatalog.ManagedIdentityMetadataPagedResponse,
      geocatalog.ListIngestionSourceManagedIdentitiesError,
      RuntimeContext
    >
  >
> {}

export const ListIngestionSourceManagedIdentities =
  Binding.Service<ListIngestionSourceManagedIdentities>(
    "Azure.PlanetaryComputer.ListIngestionSourceManagedIdentities",
  );
