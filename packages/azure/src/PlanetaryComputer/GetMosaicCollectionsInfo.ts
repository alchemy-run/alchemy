import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicCollectionsInfo` request without `endpoint`, which the bound
 * GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicCollectionsInfoRequest extends Omit<
  geocatalog.GetMosaicCollectionsInfoRequest,
  "endpoint"
> {}

/**
 * Collection Info Return search query info from a STAC collection identifier.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicCollectionsInfoHttp}.
 *
 * ### Calling GetMosaicCollectionsInfo
 * **Example:** GetMosaicCollectionsInfo from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicCollectionsInfo = yield* Azure.PlanetaryComputer.GetMosaicCollectionsInfo(catalog);
 *
 * // runtime
 * const result = yield* getMosaicCollectionsInfo(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicCollectionsInfoHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicCollectionsInfo extends Binding.Service<
  GetMosaicCollectionsInfo,
  "Azure.PlanetaryComputer.GetMosaicCollectionsInfo",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicCollectionsInfoRequest,
    ) => Effect.Effect<
      geocatalog.TilerStacSearchRegistration,
      geocatalog.GetMosaicCollectionsInfoError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicCollectionsInfo = Binding.Service<GetMosaicCollectionsInfo>(
  "Azure.PlanetaryComputer.GetMosaicCollectionsInfo",
);
