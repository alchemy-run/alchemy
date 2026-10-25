import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicCollectionsBboxCroppedToBoundingBox` request without `endpoint`,
 * which the bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicCollectionsBboxCroppedToBoundingBoxRequest extends Omit<
  geocatalog.GetMosaicCollectionsBboxCroppedToBoundingBoxRequest,
  "endpoint"
> {}

/**
 * Collection Bbox Create an image from part of a STAC collection dataset
 * (bounding box crop).
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicCollectionsBboxCroppedToBoundingBoxHttp}.
 *
 * ### Calling GetMosaicCollectionsBboxCroppedToBoundingBox
 * **Example:** GetMosaicCollectionsBboxCroppedToBoundingBox from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicCollectionsBboxCroppedToBoundingBox = yield* Azure.PlanetaryComputer.GetMosaicCollectionsBboxCroppedToBoundingBox(catalog);
 *
 * // runtime
 * const result = yield* getMosaicCollectionsBboxCroppedToBoundingBox(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicCollectionsBboxCroppedToBoundingBoxHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicCollectionsBboxCroppedToBoundingBox extends Binding.Service<
  GetMosaicCollectionsBboxCroppedToBoundingBox,
  "Azure.PlanetaryComputer.GetMosaicCollectionsBboxCroppedToBoundingBox",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicCollectionsBboxCroppedToBoundingBoxRequest,
    ) => Effect.Effect<
      geocatalog.GetMosaicCollectionsBboxCroppedToBoundingBoxResponse,
      geocatalog.GetMosaicCollectionsBboxCroppedToBoundingBoxError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicCollectionsBboxCroppedToBoundingBox =
  Binding.Service<GetMosaicCollectionsBboxCroppedToBoundingBox>(
    "Azure.PlanetaryComputer.GetMosaicCollectionsBboxCroppedToBoundingBox",
  );
