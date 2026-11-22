import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicSearchesTileSetMetadata` request without `endpoint`, which the
 * bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicSearchesTileSetMetadataRequest extends Omit<
  geocatalog.GetMosaicSearchesTileSetMetadataRequest,
  "endpoint"
> {}

/**
 * Searches Tileset Metadata Return metadata for a specific tileset of a mosaic
 * search.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicSearchesTileSetMetadataHttp}.
 *
 * ### Calling GetMosaicSearchesTileSetMetadata
 * **Example:** GetMosaicSearchesTileSetMetadata from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicSearchesTileSetMetadata = yield* Azure.PlanetaryComputer.GetMosaicSearchesTileSetMetadata(catalog);
 *
 * // runtime
 * const result = yield* getMosaicSearchesTileSetMetadata(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicSearchesTileSetMetadataHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicSearchesTileSetMetadata extends Binding.Service<
  GetMosaicSearchesTileSetMetadata,
  "Azure.PlanetaryComputer.GetMosaicSearchesTileSetMetadata",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicSearchesTileSetMetadataRequest,
    ) => Effect.Effect<
      geocatalog.TileSetMetadata,
      geocatalog.GetMosaicSearchesTileSetMetadataError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicSearchesTileSetMetadata = Binding.Service<GetMosaicSearchesTileSetMetadata>(
  "Azure.PlanetaryComputer.GetMosaicSearchesTileSetMetadata",
);
