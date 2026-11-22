import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `DeleteIngestionOperation` request without `endpoint`, which the bound
 * GeoCatalog (its `catalogUri`) supplies.
 */
export interface DeleteIngestionOperationRequest extends Omit<
  geocatalog.DeleteIngestionOperationRequest,
  "endpoint"
> {}

/**
 * Cancel a running operation of a geo-catalog collection.
 *
 * Binding assigns the built-in **GeoCatalog Administrator** role on the bound
 * catalog only: the only role the GeoCatalog data plane accepts for writes
 * (`Microsoft.Orbital` has no data actions, so no narrower custom role exists).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link DeleteIngestionOperationHttp}.
 *
 * ### Calling DeleteIngestionOperation
 * **Example:** DeleteIngestionOperation from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const deleteIngestionOperation = yield* Azure.PlanetaryComputer.DeleteIngestionOperation(catalog);
 *
 * // runtime
 * const result = yield* deleteIngestionOperation(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.DeleteIngestionOperationHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface DeleteIngestionOperation extends Binding.Service<
  DeleteIngestionOperation,
  "Azure.PlanetaryComputer.DeleteIngestionOperation",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: DeleteIngestionOperationRequest,
    ) => Effect.Effect<
      geocatalog.DeleteIngestionOperationResponse,
      geocatalog.DeleteIngestionOperationError,
      RuntimeContext
    >
  >
> {}

export const DeleteIngestionOperation = Binding.Service<DeleteIngestionOperation>(
  "Azure.PlanetaryComputer.DeleteIngestionOperation",
);
