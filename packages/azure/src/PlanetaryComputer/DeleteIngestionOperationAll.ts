import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `DeleteIngestionOperationAll` request without `endpoint`, which the bound
 * GeoCatalog (its `catalogUri`) supplies.
 */
export interface DeleteIngestionOperationAllRequest extends Omit<
  geocatalog.DeleteIngestionOperationAllRequest,
  "endpoint"
> {}

/**
 * Cancel all pending and running operations across the entire GeoCatalog
 * instance.
 *
 * Binding assigns the built-in **GeoCatalog Administrator** role on the bound
 * catalog only: the only role the GeoCatalog data plane accepts for writes
 * (`Microsoft.Orbital` has no data actions, so no narrower custom role exists).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link DeleteIngestionOperationAllHttp}.
 *
 * ### Calling DeleteIngestionOperationAll
 * **Example:** DeleteIngestionOperationAll from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const deleteIngestionOperationAll = yield* Azure.PlanetaryComputer.DeleteIngestionOperationAll(catalog);
 *
 * // runtime
 * const result = yield* deleteIngestionOperationAll();
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.DeleteIngestionOperationAllHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface DeleteIngestionOperationAll extends Binding.Service<
  DeleteIngestionOperationAll,
  "Azure.PlanetaryComputer.DeleteIngestionOperationAll",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request?: DeleteIngestionOperationAllRequest,
    ) => Effect.Effect<
      geocatalog.DeleteIngestionOperationAllResponse,
      geocatalog.DeleteIngestionOperationAllError,
      RuntimeContext
    >
  >
> {}

export const DeleteIngestionOperationAll = Binding.Service<DeleteIngestionOperationAll>(
  "Azure.PlanetaryComputer.DeleteIngestionOperationAll",
);
