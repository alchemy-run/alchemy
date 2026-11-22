import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicSearchesTileJson` request without `endpoint`, which the bound
 * GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicSearchesTileJsonRequest extends Omit<
  geocatalog.GetMosaicSearchesTileJsonRequest,
  "endpoint"
> {}

/**
 * Searches TileJson Return TileJSON document for a search.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicSearchesTileJsonHttp}.
 *
 * ### Calling GetMosaicSearchesTileJson
 * **Example:** GetMosaicSearchesTileJson from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicSearchesTileJson = yield* Azure.PlanetaryComputer.GetMosaicSearchesTileJson(catalog);
 *
 * // runtime
 * const result = yield* getMosaicSearchesTileJson(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicSearchesTileJsonHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicSearchesTileJson extends Binding.Service<
  GetMosaicSearchesTileJson,
  "Azure.PlanetaryComputer.GetMosaicSearchesTileJson",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicSearchesTileJsonRequest,
    ) => Effect.Effect<
      geocatalog.TileJsonMetadata,
      geocatalog.GetMosaicSearchesTileJsonError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicSearchesTileJson = Binding.Service<GetMosaicSearchesTileJson>(
  "Azure.PlanetaryComputer.GetMosaicSearchesTileJson",
);
