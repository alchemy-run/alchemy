import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `CreateIngestion` request without `endpoint`, which the bound GeoCatalog (its
 * `catalogUri`) supplies.
 */
export interface CreateIngestionRequest extends Omit<
  geocatalog.CreateIngestionRequest,
  "endpoint"
> {}

/**
 * Create a new ingestion.
 *
 * Binding assigns the built-in **GeoCatalog Administrator** role on the bound
 * catalog only: the only role the GeoCatalog data plane accepts for writes
 * (`Microsoft.Orbital` has no data actions, so no narrower custom role exists).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link CreateIngestionHttp}.
 *
 * ### Calling CreateIngestion
 * **Example:** CreateIngestion from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const createIngestion = yield* Azure.PlanetaryComputer.CreateIngestion(catalog);
 *
 * // runtime
 * const result = yield* createIngestion({ collectionId: "sentinel-2", importType: "StaticCatalog", sourceCatalogUrl: catalogJsonUrl });
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.CreateIngestionHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface CreateIngestion extends Binding.Service<
  CreateIngestion,
  "Azure.PlanetaryComputer.CreateIngestion",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: CreateIngestionRequest,
    ) => Effect.Effect<
      geocatalog.CreateIngestionResponse,
      geocatalog.CreateIngestionError,
      RuntimeContext
    >
  >
> {}

export const CreateIngestion = Binding.Service<CreateIngestion>(
  "Azure.PlanetaryComputer.CreateIngestion",
);
