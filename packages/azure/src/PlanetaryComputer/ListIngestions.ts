import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `ListIngestions` request without `endpoint`, which the bound GeoCatalog (its
 * `catalogUri`) supplies.
 */
export interface ListIngestionsRequest extends Omit<geocatalog.ListIngestionsRequest, "endpoint"> {}

/**
 * List a collection's ingestions. One page per call: pass `nextLink` for the
 * next.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link ListIngestionsHttp}.
 *
 * ### Calling ListIngestions
 * **Example:** ListIngestions from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const listIngestions = yield* Azure.PlanetaryComputer.ListIngestions(catalog);
 *
 * // runtime
 * const result = yield* listIngestions({ collectionId: "sentinel-2" });
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.ListIngestionsHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface ListIngestions extends Binding.Service<
  ListIngestions,
  "Azure.PlanetaryComputer.ListIngestions",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: ListIngestionsRequest,
    ) => Effect.Effect<
      geocatalog.IngestionDefinitionPagedResponse,
      geocatalog.ListIngestionsError,
      RuntimeContext
    >
  >
> {}

export const ListIngestions = Binding.Service<ListIngestions>(
  "Azure.PlanetaryComputer.ListIngestions",
);
