import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetIngestionOperation` request without `endpoint`, which the bound
 * GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetIngestionOperationRequest extends Omit<
  geocatalog.GetIngestionOperationRequest,
  "endpoint"
> {}

/**
 * Get an operation of a geo-catalog collection.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetIngestionOperationHttp}.
 *
 * ### Calling GetIngestionOperation
 * **Example:** GetIngestionOperation from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getIngestionOperation = yield* Azure.PlanetaryComputer.GetIngestionOperation(catalog);
 *
 * // runtime
 * const result = yield* getIngestionOperation(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetIngestionOperationHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetIngestionOperation extends Binding.Service<
  GetIngestionOperation,
  "Azure.PlanetaryComputer.GetIngestionOperation",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetIngestionOperationRequest,
    ) => Effect.Effect<geocatalog.Operation, geocatalog.GetIngestionOperationError, RuntimeContext>
  >
> {}

export const GetIngestionOperation = Binding.Service<GetIngestionOperation>(
  "Azure.PlanetaryComputer.GetIngestionOperation",
);
