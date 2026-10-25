import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicItemsTilesPlainZxy` request without `endpoint`, which the bound
 * GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicItemsTilesPlainZxyRequest extends Omit<
  geocatalog.GetMosaicItemsTilesPlainZxyRequest,
  "endpoint"
> {}

/**
 * Render one map tile of a STAC item.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicItemsTilesPlainZxyHttp}.
 *
 * ### Calling GetMosaicItemsTilesPlainZxy
 * **Example:** GetMosaicItemsTilesPlainZxy from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicItemsTilesPlainZxy = yield* Azure.PlanetaryComputer.GetMosaicItemsTilesPlainZxy(catalog);
 *
 * // runtime
 * const result = yield* getMosaicItemsTilesPlainZxy({ collectionId: "sentinel-2", itemId: "S2A_T32TNS_20240101", z: 10, x: 535, y: 360, assets: ["visual"] });
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicItemsTilesPlainZxyHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicItemsTilesPlainZxy extends Binding.Service<
  GetMosaicItemsTilesPlainZxy,
  "Azure.PlanetaryComputer.GetMosaicItemsTilesPlainZxy",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicItemsTilesPlainZxyRequest,
    ) => Effect.Effect<
      geocatalog.GetMosaicItemsTilesPlainZxyResponse,
      geocatalog.GetMosaicItemsTilesPlainZxyError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicItemsTilesPlainZxy = Binding.Service<GetMosaicItemsTilesPlainZxy>(
  "Azure.PlanetaryComputer.GetMosaicItemsTilesPlainZxy",
);
