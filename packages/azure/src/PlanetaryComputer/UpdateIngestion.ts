import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `UpdateIngestion` request without `endpoint`, which the bound GeoCatalog (its
 * `catalogUri`) supplies.
 */
export interface UpdateIngestionRequest extends Omit<
  geocatalog.UpdateIngestionRequest,
  "endpoint"
> {}

/**
 * Update an existing ingestion.
 *
 * Binding assigns the built-in **GeoCatalog Administrator** role on the bound
 * catalog only: the only role the GeoCatalog data plane accepts for writes
 * (`Microsoft.Orbital` has no data actions, so no narrower custom role exists).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link UpdateIngestionHttp}.
 *
 * ### Calling UpdateIngestion
 * **Example:** UpdateIngestion from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const updateIngestion = yield* Azure.PlanetaryComputer.UpdateIngestion(catalog);
 *
 * // runtime
 * const result = yield* updateIngestion(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.UpdateIngestionHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface UpdateIngestion extends Binding.Service<
  UpdateIngestion,
  "Azure.PlanetaryComputer.UpdateIngestion",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: UpdateIngestionRequest,
    ) => Effect.Effect<
      geocatalog.IngestionDefinition,
      geocatalog.UpdateIngestionError,
      RuntimeContext
    >
  >
> {}

export const UpdateIngestion = Binding.Service<UpdateIngestion>(
  "Azure.PlanetaryComputer.UpdateIngestion",
);
