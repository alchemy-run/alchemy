import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicCollectionsTileSetMetadata` request without `endpoint`, which the
 * bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicCollectionsTileSetMetadataRequest extends Omit<
  geocatalog.GetMosaicCollectionsTileSetMetadataRequest,
  "endpoint"
> {}

/**
 * Collection Tileset Metadata Return metadata for a specific tileset of a STAC
 * collection.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicCollectionsTileSetMetadataHttp}.
 *
 * ### Calling GetMosaicCollectionsTileSetMetadata
 * **Example:** GetMosaicCollectionsTileSetMetadata from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicCollectionsTileSetMetadata = yield* Azure.PlanetaryComputer.GetMosaicCollectionsTileSetMetadata(catalog);
 *
 * // runtime
 * const result = yield* getMosaicCollectionsTileSetMetadata(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicCollectionsTileSetMetadataHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicCollectionsTileSetMetadata extends Binding.Service<
  GetMosaicCollectionsTileSetMetadata,
  "Azure.PlanetaryComputer.GetMosaicCollectionsTileSetMetadata",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicCollectionsTileSetMetadataRequest,
    ) => Effect.Effect<
      geocatalog.TileSetMetadata,
      geocatalog.GetMosaicCollectionsTileSetMetadataError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicCollectionsTileSetMetadata =
  Binding.Service<GetMosaicCollectionsTileSetMetadata>(
    "Azure.PlanetaryComputer.GetMosaicCollectionsTileSetMetadata",
  );
