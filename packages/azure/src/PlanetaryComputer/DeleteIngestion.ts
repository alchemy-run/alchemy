import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `DeleteIngestion` request without `endpoint`, which the bound GeoCatalog (its
 * `catalogUri`) supplies.
 */
export interface DeleteIngestionRequest extends Omit<
  geocatalog.DeleteIngestionRequest,
  "endpoint"
> {}

/**
 * Delete an ingestion from a catalog.
 *
 * Binding assigns the built-in **GeoCatalog Administrator** role on the bound
 * catalog only: the only role the GeoCatalog data plane accepts for writes
 * (`Microsoft.Orbital` has no data actions, so no narrower custom role exists).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link DeleteIngestionHttp}.
 *
 * ### Calling DeleteIngestion
 * **Example:** DeleteIngestion from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const deleteIngestion = yield* Azure.PlanetaryComputer.DeleteIngestion(catalog);
 *
 * // runtime
 * const result = yield* deleteIngestion({ collectionId: "sentinel-2", ingestionId });
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.DeleteIngestionHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface DeleteIngestion extends Binding.Service<
  DeleteIngestion,
  "Azure.PlanetaryComputer.DeleteIngestion",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: DeleteIngestionRequest,
    ) => Effect.Effect<
      geocatalog.DeleteIngestionResponse,
      geocatalog.DeleteIngestionError,
      RuntimeContext
    >
  >
> {}

export const DeleteIngestion = Binding.Service<DeleteIngestion>(
  "Azure.PlanetaryComputer.DeleteIngestion",
);
