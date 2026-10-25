import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `ListIngestionRuns` request without `endpoint`, which the bound GeoCatalog
 * (its `catalogUri`) supplies.
 */
export interface ListIngestionRunsRequest extends Omit<
  geocatalog.ListIngestionRunsRequest,
  "endpoint"
> {}

/**
 * List the runs of an ingestion. One page per call: pass `nextLink` for the
 * next.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link ListIngestionRunsHttp}.
 *
 * ### Calling ListIngestionRuns
 * **Example:** ListIngestionRuns from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const listIngestionRuns = yield* Azure.PlanetaryComputer.ListIngestionRuns(catalog);
 *
 * // runtime
 * const result = yield* listIngestionRuns({ collectionId: "sentinel-2", ingestionId });
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.ListIngestionRunsHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface ListIngestionRuns extends Binding.Service<
  ListIngestionRuns,
  "Azure.PlanetaryComputer.ListIngestionRuns",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: ListIngestionRunsRequest,
    ) => Effect.Effect<
      geocatalog.IngestionRunPagedResponse,
      geocatalog.ListIngestionRunsError,
      RuntimeContext
    >
  >
> {}

export const ListIngestionRuns = Binding.Service<ListIngestionRuns>(
  "Azure.PlanetaryComputer.ListIngestionRuns",
);
