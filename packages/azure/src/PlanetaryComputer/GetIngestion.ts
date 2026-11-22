import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetIngestion` request without `endpoint`, which the bound GeoCatalog (its
 * `catalogUri`) supplies.
 */
export interface GetIngestionRequest extends Omit<geocatalog.GetIngestionRequest, "endpoint"> {}

/**
 * Get the definition of an ingestion.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetIngestionHttp}.
 *
 * ### Calling GetIngestion
 * **Example:** GetIngestion from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getIngestion = yield* Azure.PlanetaryComputer.GetIngestion(catalog);
 *
 * // runtime
 * const result = yield* getIngestion({ collectionId: "sentinel-2", ingestionId });
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetIngestionHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetIngestion extends Binding.Service<
  GetIngestion,
  "Azure.PlanetaryComputer.GetIngestion",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetIngestionRequest,
    ) => Effect.Effect<geocatalog.IngestionDefinition, geocatalog.GetIngestionError, RuntimeContext>
  >
> {}

export const GetIngestion = Binding.Service<GetIngestion>("Azure.PlanetaryComputer.GetIngestion");
