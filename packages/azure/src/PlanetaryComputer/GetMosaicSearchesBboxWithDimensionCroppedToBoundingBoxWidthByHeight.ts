import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicSearchesBboxWithDimensionCroppedToBoundingBoxWidthByHeight` request
 * without `endpoint`, which the bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicSearchesBboxWithDimensionCroppedToBoundingBoxWidthByHeightRequest extends Omit<
  geocatalog.GetMosaicSearchesBboxWithDimensionCroppedToBoundingBoxWidthByHeightRequest,
  "endpoint"
> {}

/**
 * Searches Bbox With Dimensions Create an image from part of a dataset
 * (bounding box crop with dimensions).
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicSearchesBboxWithDimensionCroppedToBoundingBoxWidthByHeightHttp}.
 *
 * ### Calling GetMosaicSearchesBboxWithDimensionCroppedToBoundingBoxWidthByHeight
 * **Example:** GetMosaicSearchesBboxWithDimensionCroppedToBoundingBoxWidthByHeight from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicSearchesBboxWithDimensionCroppedToBoundingBoxWidthByHeight = yield* Azure.PlanetaryComputer.GetMosaicSearchesBboxWithDimensionCroppedToBoundingBoxWidthByHeight(catalog);
 *
 * // runtime
 * const result = yield* getMosaicSearchesBboxWithDimensionCroppedToBoundingBoxWidthByHeight(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicSearchesBboxWithDimensionCroppedToBoundingBoxWidthByHeightHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicSearchesBboxWithDimensionCroppedToBoundingBoxWidthByHeight extends Binding.Service<
  GetMosaicSearchesBboxWithDimensionCroppedToBoundingBoxWidthByHeight,
  "Azure.PlanetaryComputer.GetMosaicSearchesBboxWithDimensionCroppedToBoundingBoxWidthByHeight",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicSearchesBboxWithDimensionCroppedToBoundingBoxWidthByHeightRequest,
    ) => Effect.Effect<
      geocatalog.GetMosaicSearchesBboxWithDimensionCroppedToBoundingBoxWidthByHeightResponse,
      geocatalog.GetMosaicSearchesBboxWithDimensionCroppedToBoundingBoxWidthByHeightError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicSearchesBboxWithDimensionCroppedToBoundingBoxWidthByHeight =
  Binding.Service<GetMosaicSearchesBboxWithDimensionCroppedToBoundingBoxWidthByHeight>(
    "Azure.PlanetaryComputer.GetMosaicSearchesBboxWithDimensionCroppedToBoundingBoxWidthByHeight",
  );
