import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicCollectionsTileMatrixSetsTileJson` request without `endpoint`,
 * which the bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicCollectionsTileMatrixSetsTileJsonRequest extends Omit<
  geocatalog.GetMosaicCollectionsTileMatrixSetsTileJsonRequest,
  "endpoint"
> {}

/**
 * Collection TileJson Tilematrixsetid As Path Return TileJSON document for a
 * STAC collection with TileMatrixSetId as path.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicCollectionsTileMatrixSetsTileJsonHttp}.
 *
 * ### Calling GetMosaicCollectionsTileMatrixSetsTileJson
 * **Example:** GetMosaicCollectionsTileMatrixSetsTileJson from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicCollectionsTileMatrixSetsTileJson = yield* Azure.PlanetaryComputer.GetMosaicCollectionsTileMatrixSetsTileJson(catalog);
 *
 * // runtime
 * const result = yield* getMosaicCollectionsTileMatrixSetsTileJson(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicCollectionsTileMatrixSetsTileJsonHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicCollectionsTileMatrixSetsTileJson extends Binding.Service<
  GetMosaicCollectionsTileMatrixSetsTileJson,
  "Azure.PlanetaryComputer.GetMosaicCollectionsTileMatrixSetsTileJson",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicCollectionsTileMatrixSetsTileJsonRequest,
    ) => Effect.Effect<
      geocatalog.TileJsonMetadata,
      geocatalog.GetMosaicCollectionsTileMatrixSetsTileJsonError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicCollectionsTileMatrixSetsTileJson =
  Binding.Service<GetMosaicCollectionsTileMatrixSetsTileJson>(
    "Azure.PlanetaryComputer.GetMosaicCollectionsTileMatrixSetsTileJson",
  );
