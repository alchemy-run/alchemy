import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicSearchesTileMatrixSetsTileJson` request without `endpoint`, which
 * the bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicSearchesTileMatrixSetsTileJsonRequest extends Omit<
  geocatalog.GetMosaicSearchesTileMatrixSetsTileJsonRequest,
  "endpoint"
> {}

/**
 * Searches TileJson Tilematrixsetid As Path Return TileJSON document for a
 * search with TileMatrixSetId as path.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicSearchesTileMatrixSetsTileJsonHttp}.
 *
 * ### Calling GetMosaicSearchesTileMatrixSetsTileJson
 * **Example:** GetMosaicSearchesTileMatrixSetsTileJson from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicSearchesTileMatrixSetsTileJson = yield* Azure.PlanetaryComputer.GetMosaicSearchesTileMatrixSetsTileJson(catalog);
 *
 * // runtime
 * const result = yield* getMosaicSearchesTileMatrixSetsTileJson(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicSearchesTileMatrixSetsTileJsonHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicSearchesTileMatrixSetsTileJson extends Binding.Service<
  GetMosaicSearchesTileMatrixSetsTileJson,
  "Azure.PlanetaryComputer.GetMosaicSearchesTileMatrixSetsTileJson",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicSearchesTileMatrixSetsTileJsonRequest,
    ) => Effect.Effect<
      geocatalog.TileJsonMetadata,
      geocatalog.GetMosaicSearchesTileMatrixSetsTileJsonError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicSearchesTileMatrixSetsTileJson =
  Binding.Service<GetMosaicSearchesTileMatrixSetsTileJson>(
    "Azure.PlanetaryComputer.GetMosaicSearchesTileMatrixSetsTileJson",
  );
