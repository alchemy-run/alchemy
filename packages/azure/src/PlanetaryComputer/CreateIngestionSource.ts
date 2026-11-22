import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `CreateIngestionSource` request without `endpoint`, which the bound
 * GeoCatalog (its `catalogUri`) supplies.
 */
export interface CreateIngestionSourceRequest extends Omit<
  geocatalog.CreateIngestionSourceRequest,
  "endpoint"
> {}

/**
 * Create a new ingestion source in a geo-catalog.
 *
 * Binding assigns the built-in **GeoCatalog Administrator** role on the bound
 * catalog only: the only role the GeoCatalog data plane accepts for writes
 * (`Microsoft.Orbital` has no data actions, so no narrower custom role exists).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link CreateIngestionSourceHttp}.
 *
 * ### Calling CreateIngestionSource
 * **Example:** CreateIngestionSource from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const createIngestionSource = yield* Azure.PlanetaryComputer.CreateIngestionSource(catalog);
 *
 * // runtime
 * const result = yield* createIngestionSource({ id: sourceId, kind: "BlobManagedIdentity" });
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.CreateIngestionSourceHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface CreateIngestionSource extends Binding.Service<
  CreateIngestionSource,
  "Azure.PlanetaryComputer.CreateIngestionSource",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: CreateIngestionSourceRequest,
    ) => Effect.Effect<
      geocatalog.CreateIngestionSourceResponse,
      geocatalog.CreateIngestionSourceError,
      RuntimeContext
    >
  >
> {}

export const CreateIngestionSource = Binding.Service<CreateIngestionSource>(
  "Azure.PlanetaryComputer.CreateIngestionSource",
);
