import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `DeleteIngestionSource` request without `endpoint`, which the bound
 * GeoCatalog (its `catalogUri`) supplies.
 */
export interface DeleteIngestionSourceRequest extends Omit<
  geocatalog.DeleteIngestionSourceRequest,
  "endpoint"
> {}

/**
 * Delete an ingestion source from a geo-catalog.
 *
 * Binding assigns the built-in **GeoCatalog Administrator** role on the bound
 * catalog only: the only role the GeoCatalog data plane accepts for writes
 * (`Microsoft.Orbital` has no data actions, so no narrower custom role exists).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link DeleteIngestionSourceHttp}.
 *
 * ### Calling DeleteIngestionSource
 * **Example:** DeleteIngestionSource from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const deleteIngestionSource = yield* Azure.PlanetaryComputer.DeleteIngestionSource(catalog);
 *
 * // runtime
 * const result = yield* deleteIngestionSource(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.DeleteIngestionSourceHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface DeleteIngestionSource extends Binding.Service<
  DeleteIngestionSource,
  "Azure.PlanetaryComputer.DeleteIngestionSource",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: DeleteIngestionSourceRequest,
    ) => Effect.Effect<
      geocatalog.DeleteIngestionSourceResponse,
      geocatalog.DeleteIngestionSourceError,
      RuntimeContext
    >
  >
> {}

export const DeleteIngestionSource = Binding.Service<DeleteIngestionSource>(
  "Azure.PlanetaryComputer.DeleteIngestionSource",
);
