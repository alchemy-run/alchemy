import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicItemsBboxWithDimensionCroppedToBoundingBoxWidthByHeight` request
 * without `endpoint`, which the bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicItemsBboxWithDimensionCroppedToBoundingBoxWidthByHeightRequest extends Omit<
  geocatalog.GetMosaicItemsBboxWithDimensionCroppedToBoundingBoxWidthByHeightRequest,
  "endpoint"
> {}

/**
 * Item Bbox With Dimensions Create an image from part of a STAC item dataset
 * (bounding box crop with dimensions).
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicItemsBboxWithDimensionCroppedToBoundingBoxWidthByHeightHttp}.
 *
 * ### Calling GetMosaicItemsBboxWithDimensionCroppedToBoundingBoxWidthByHeight
 * **Example:** GetMosaicItemsBboxWithDimensionCroppedToBoundingBoxWidthByHeight from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicItemsBboxWithDimensionCroppedToBoundingBoxWidthByHeight = yield* Azure.PlanetaryComputer.GetMosaicItemsBboxWithDimensionCroppedToBoundingBoxWidthByHeight(catalog);
 *
 * // runtime
 * const result = yield* getMosaicItemsBboxWithDimensionCroppedToBoundingBoxWidthByHeight(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicItemsBboxWithDimensionCroppedToBoundingBoxWidthByHeightHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicItemsBboxWithDimensionCroppedToBoundingBoxWidthByHeight extends Binding.Service<
  GetMosaicItemsBboxWithDimensionCroppedToBoundingBoxWidthByHeight,
  "Azure.PlanetaryComputer.GetMosaicItemsBboxWithDimensionCroppedToBoundingBoxWidthByHeight",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicItemsBboxWithDimensionCroppedToBoundingBoxWidthByHeightRequest,
    ) => Effect.Effect<
      geocatalog.GetMosaicItemsBboxWithDimensionCroppedToBoundingBoxWidthByHeightResponse,
      geocatalog.GetMosaicItemsBboxWithDimensionCroppedToBoundingBoxWidthByHeightError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicItemsBboxWithDimensionCroppedToBoundingBoxWidthByHeight =
  Binding.Service<GetMosaicItemsBboxWithDimensionCroppedToBoundingBoxWidthByHeight>(
    "Azure.PlanetaryComputer.GetMosaicItemsBboxWithDimensionCroppedToBoundingBoxWidthByHeight",
  );
