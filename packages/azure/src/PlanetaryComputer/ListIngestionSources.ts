import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `ListIngestionSources` request without `endpoint`, which the bound GeoCatalog
 * (its `catalogUri`) supplies.
 */
export interface ListIngestionSourcesRequest extends Omit<
  geocatalog.ListIngestionSourcesRequest,
  "endpoint"
> {}

/**
 * List the catalog's ingestion sources. One page per call: pass `nextLink` for
 * the next.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link ListIngestionSourcesHttp}.
 *
 * ### Calling ListIngestionSources
 * **Example:** ListIngestionSources from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const listIngestionSources = yield* Azure.PlanetaryComputer.ListIngestionSources(catalog);
 *
 * // runtime
 * const result = yield* listIngestionSources();
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.ListIngestionSourcesHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface ListIngestionSources extends Binding.Service<
  ListIngestionSources,
  "Azure.PlanetaryComputer.ListIngestionSources",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request?: ListIngestionSourcesRequest,
    ) => Effect.Effect<
      geocatalog.IngestionSourceSummaryPagedResponse,
      geocatalog.ListIngestionSourcesError,
      RuntimeContext
    >
  >
> {}

export const ListIngestionSources = Binding.Service<ListIngestionSources>(
  "Azure.PlanetaryComputer.ListIngestionSources",
);
