import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetIngestionSource` request without `endpoint`, which the bound GeoCatalog
 * (its `catalogUri`) supplies.
 */
export interface GetIngestionSourceRequest extends Omit<
  geocatalog.GetIngestionSourceRequest,
  "endpoint"
> {}

/**
 * Get an ingestion source in a geo-catalog.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetIngestionSourceHttp}.
 *
 * ### Calling GetIngestionSource
 * **Example:** GetIngestionSource from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getIngestionSource = yield* Azure.PlanetaryComputer.GetIngestionSource(catalog);
 *
 * // runtime
 * const result = yield* getIngestionSource(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetIngestionSourceHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetIngestionSource extends Binding.Service<
  GetIngestionSource,
  "Azure.PlanetaryComputer.GetIngestionSource",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetIngestionSourceRequest,
    ) => Effect.Effect<
      geocatalog.IngestionSource,
      geocatalog.GetIngestionSourceError,
      RuntimeContext
    >
  >
> {}

export const GetIngestionSource = Binding.Service<GetIngestionSource>(
  "Azure.PlanetaryComputer.GetIngestionSource",
);
