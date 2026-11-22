import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetIngestionRun` request without `endpoint`, which the bound GeoCatalog (its
 * `catalogUri`) supplies.
 */
export interface GetIngestionRunRequest extends Omit<
  geocatalog.GetIngestionRunRequest,
  "endpoint"
> {}

/**
 * Get a run of an ingestion.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetIngestionRunHttp}.
 *
 * ### Calling GetIngestionRun
 * **Example:** GetIngestionRun from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getIngestionRun = yield* Azure.PlanetaryComputer.GetIngestionRun(catalog);
 *
 * // runtime
 * const result = yield* getIngestionRun({ collectionId: "sentinel-2", ingestionId, runId });
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetIngestionRunHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetIngestionRun extends Binding.Service<
  GetIngestionRun,
  "Azure.PlanetaryComputer.GetIngestionRun",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetIngestionRunRequest,
    ) => Effect.Effect<geocatalog.IngestionRun, geocatalog.GetIngestionRunError, RuntimeContext>
  >
> {}

export const GetIngestionRun = Binding.Service<GetIngestionRun>(
  "Azure.PlanetaryComputer.GetIngestionRun",
);
