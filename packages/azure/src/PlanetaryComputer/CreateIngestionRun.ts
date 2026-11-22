import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `CreateIngestionRun` request without `endpoint`, which the bound GeoCatalog
 * (its `catalogUri`) supplies.
 */
export interface CreateIngestionRunRequest extends Omit<
  geocatalog.CreateIngestionRunRequest,
  "endpoint"
> {}

/**
 * Create a new run of an ingestion.
 *
 * Binding assigns the built-in **GeoCatalog Administrator** role on the bound
 * catalog only: the only role the GeoCatalog data plane accepts for writes
 * (`Microsoft.Orbital` has no data actions, so no narrower custom role exists).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link CreateIngestionRunHttp}.
 *
 * ### Calling CreateIngestionRun
 * **Example:** CreateIngestionRun from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const createIngestionRun = yield* Azure.PlanetaryComputer.CreateIngestionRun(catalog);
 *
 * // runtime
 * const result = yield* createIngestionRun({ collectionId: "sentinel-2", ingestionId });
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.CreateIngestionRunHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface CreateIngestionRun extends Binding.Service<
  CreateIngestionRun,
  "Azure.PlanetaryComputer.CreateIngestionRun",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: CreateIngestionRunRequest,
    ) => Effect.Effect<
      geocatalog.CreateIngestionRunResponse,
      geocatalog.CreateIngestionRunError,
      RuntimeContext
    >
  >
> {}

export const CreateIngestionRun = Binding.Service<CreateIngestionRun>(
  "Azure.PlanetaryComputer.CreateIngestionRun",
);
