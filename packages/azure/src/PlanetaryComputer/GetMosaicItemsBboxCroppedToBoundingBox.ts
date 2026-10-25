import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicItemsBboxCroppedToBoundingBox` request without `endpoint`, which
 * the bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicItemsBboxCroppedToBoundingBoxRequest extends Omit<
  geocatalog.GetMosaicItemsBboxCroppedToBoundingBoxRequest,
  "endpoint"
> {}

/**
 * Item Bbox Create an image from part of a STAC item dataset (bounding box
 * crop).
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicItemsBboxCroppedToBoundingBoxHttp}.
 *
 * ### Calling GetMosaicItemsBboxCroppedToBoundingBox
 * **Example:** GetMosaicItemsBboxCroppedToBoundingBox from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicItemsBboxCroppedToBoundingBox = yield* Azure.PlanetaryComputer.GetMosaicItemsBboxCroppedToBoundingBox(catalog);
 *
 * // runtime
 * const result = yield* getMosaicItemsBboxCroppedToBoundingBox(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicItemsBboxCroppedToBoundingBoxHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicItemsBboxCroppedToBoundingBox extends Binding.Service<
  GetMosaicItemsBboxCroppedToBoundingBox,
  "Azure.PlanetaryComputer.GetMosaicItemsBboxCroppedToBoundingBox",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicItemsBboxCroppedToBoundingBoxRequest,
    ) => Effect.Effect<
      geocatalog.GetMosaicItemsBboxCroppedToBoundingBoxResponse,
      geocatalog.GetMosaicItemsBboxCroppedToBoundingBoxError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicItemsBboxCroppedToBoundingBox =
  Binding.Service<GetMosaicItemsBboxCroppedToBoundingBox>(
    "Azure.PlanetaryComputer.GetMosaicItemsBboxCroppedToBoundingBox",
  );
