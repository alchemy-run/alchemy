import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicCollectionsTileJson` request without `endpoint`, which the bound
 * GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicCollectionsTileJsonRequest extends Omit<
  geocatalog.GetMosaicCollectionsTileJsonRequest,
  "endpoint"
> {}

/**
 * Collection TileJson Return TileJSON document for a STAC collection.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicCollectionsTileJsonHttp}.
 *
 * ### Calling GetMosaicCollectionsTileJson
 * **Example:** GetMosaicCollectionsTileJson from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicCollectionsTileJson = yield* Azure.PlanetaryComputer.GetMosaicCollectionsTileJson(catalog);
 *
 * // runtime
 * const result = yield* getMosaicCollectionsTileJson(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicCollectionsTileJsonHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicCollectionsTileJson extends Binding.Service<
  GetMosaicCollectionsTileJson,
  "Azure.PlanetaryComputer.GetMosaicCollectionsTileJson",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicCollectionsTileJsonRequest,
    ) => Effect.Effect<
      geocatalog.TileJsonMetadata,
      geocatalog.GetMosaicCollectionsTileJsonError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicCollectionsTileJson = Binding.Service<GetMosaicCollectionsTileJson>(
  "Azure.PlanetaryComputer.GetMosaicCollectionsTileJson",
);
