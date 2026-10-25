import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicItemsTileMatrixSetsTileJson` request without `endpoint`, which the
 * bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicItemsTileMatrixSetsTileJsonRequest extends Omit<
  geocatalog.GetMosaicItemsTileMatrixSetsTileJsonRequest,
  "endpoint"
> {}

/**
 * Item TileJson Tilematrixsetid As Path Return TileJSON document for a STAC
 * item with TileMatrixSetId as path.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicItemsTileMatrixSetsTileJsonHttp}.
 *
 * ### Calling GetMosaicItemsTileMatrixSetsTileJson
 * **Example:** GetMosaicItemsTileMatrixSetsTileJson from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicItemsTileMatrixSetsTileJson = yield* Azure.PlanetaryComputer.GetMosaicItemsTileMatrixSetsTileJson(catalog);
 *
 * // runtime
 * const result = yield* getMosaicItemsTileMatrixSetsTileJson(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicItemsTileMatrixSetsTileJsonHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicItemsTileMatrixSetsTileJson extends Binding.Service<
  GetMosaicItemsTileMatrixSetsTileJson,
  "Azure.PlanetaryComputer.GetMosaicItemsTileMatrixSetsTileJson",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicItemsTileMatrixSetsTileJsonRequest,
    ) => Effect.Effect<
      geocatalog.TileJsonMetadata,
      geocatalog.GetMosaicItemsTileMatrixSetsTileJsonError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicItemsTileMatrixSetsTileJson =
  Binding.Service<GetMosaicItemsTileMatrixSetsTileJson>(
    "Azure.PlanetaryComputer.GetMosaicItemsTileMatrixSetsTileJson",
  );
