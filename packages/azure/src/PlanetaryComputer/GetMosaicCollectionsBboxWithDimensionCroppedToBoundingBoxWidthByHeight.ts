import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicCollectionsBboxWithDimensionCroppedToBoundingBoxWidthByHeight`
 * request without `endpoint`, which the bound GeoCatalog (its `catalogUri`)
 * supplies.
 */
export interface GetMosaicCollectionsBboxWithDimensionCroppedToBoundingBoxWidthByHeightRequest extends Omit<
  geocatalog.GetMosaicCollectionsBboxWithDimensionCroppedToBoundingBoxWidthByHeightRequest,
  "endpoint"
> {}

/**
 * Collection Bbox With Dimensions Create an image from part of a STAC
 * collection dataset (bounding box crop with dimensions).
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicCollectionsBboxWithDimensionCroppedToBoundingBoxWidthByHeightHttp}.
 *
 * ### Calling GetMosaicCollectionsBboxWithDimensionCroppedToBoundingBoxWidthByHeight
 * **Example:** GetMosaicCollectionsBboxWithDimensionCroppedToBoundingBoxWidthByHeight from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicCollectionsBboxWithDimensionCroppedToBoundingBoxWidthByHeight = yield* Azure.PlanetaryComputer.GetMosaicCollectionsBboxWithDimensionCroppedToBoundingBoxWidthByHeight(catalog);
 *
 * // runtime
 * const result = yield* getMosaicCollectionsBboxWithDimensionCroppedToBoundingBoxWidthByHeight(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicCollectionsBboxWithDimensionCroppedToBoundingBoxWidthByHeightHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicCollectionsBboxWithDimensionCroppedToBoundingBoxWidthByHeight extends Binding.Service<
  GetMosaicCollectionsBboxWithDimensionCroppedToBoundingBoxWidthByHeight,
  "Azure.PlanetaryComputer.GetMosaicCollectionsBboxWithDimensionCroppedToBoundingBoxWidthByHeight",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicCollectionsBboxWithDimensionCroppedToBoundingBoxWidthByHeightRequest,
    ) => Effect.Effect<
      geocatalog.GetMosaicCollectionsBboxWithDimensionCroppedToBoundingBoxWidthByHeightResponse,
      geocatalog.GetMosaicCollectionsBboxWithDimensionCroppedToBoundingBoxWidthByHeightError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicCollectionsBboxWithDimensionCroppedToBoundingBoxWidthByHeight =
  Binding.Service<GetMosaicCollectionsBboxWithDimensionCroppedToBoundingBoxWidthByHeight>(
    "Azure.PlanetaryComputer.GetMosaicCollectionsBboxWithDimensionCroppedToBoundingBoxWidthByHeight",
  );
