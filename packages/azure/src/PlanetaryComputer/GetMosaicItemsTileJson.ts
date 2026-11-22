import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicItemsTileJson` request without `endpoint`, which the bound
 * GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicItemsTileJsonRequest extends Omit<
  geocatalog.GetMosaicItemsTileJsonRequest,
  "endpoint"
> {}

/**
 * Item TileJson Return TileJSON document for a STAC item.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicItemsTileJsonHttp}.
 *
 * ### Calling GetMosaicItemsTileJson
 * **Example:** GetMosaicItemsTileJson from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicItemsTileJson = yield* Azure.PlanetaryComputer.GetMosaicItemsTileJson(catalog);
 *
 * // runtime
 * const result = yield* getMosaicItemsTileJson(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicItemsTileJsonHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicItemsTileJson extends Binding.Service<
  GetMosaicItemsTileJson,
  "Azure.PlanetaryComputer.GetMosaicItemsTileJson",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicItemsTileJsonRequest,
    ) => Effect.Effect<
      geocatalog.TileJsonMetadata,
      geocatalog.GetMosaicItemsTileJsonError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicItemsTileJson = Binding.Service<GetMosaicItemsTileJson>(
  "Azure.PlanetaryComputer.GetMosaicItemsTileJson",
);
