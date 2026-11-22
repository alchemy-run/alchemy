import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicCollectionsPointPoint` request without `endpoint`, which the bound
 * GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicCollectionsPointPointRequest extends Omit<
  geocatalog.GetMosaicCollectionsPointPointRequest,
  "endpoint"
> {}

/**
 * Collection Point Get Point value for a collection dataset.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicCollectionsPointPointHttp}.
 *
 * ### Calling GetMosaicCollectionsPointPoint
 * **Example:** GetMosaicCollectionsPointPoint from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicCollectionsPointPoint = yield* Azure.PlanetaryComputer.GetMosaicCollectionsPointPoint(catalog);
 *
 * // runtime
 * const result = yield* getMosaicCollectionsPointPoint(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicCollectionsPointPointHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicCollectionsPointPoint extends Binding.Service<
  GetMosaicCollectionsPointPoint,
  "Azure.PlanetaryComputer.GetMosaicCollectionsPointPoint",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicCollectionsPointPointRequest,
    ) => Effect.Effect<
      geocatalog.TilerCoreModelsResponsesPoint,
      geocatalog.GetMosaicCollectionsPointPointError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicCollectionsPointPoint = Binding.Service<GetMosaicCollectionsPointPoint>(
  "Azure.PlanetaryComputer.GetMosaicCollectionsPointPoint",
);
