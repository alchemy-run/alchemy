import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicSearchesBboxCroppedToBoundingBox` request without `endpoint`, which
 * the bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicSearchesBboxCroppedToBoundingBoxRequest extends Omit<
  geocatalog.GetMosaicSearchesBboxCroppedToBoundingBoxRequest,
  "endpoint"
> {}

/**
 * Searches Bbox Create an image from part of a dataset (bounding box crop).
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicSearchesBboxCroppedToBoundingBoxHttp}.
 *
 * ### Calling GetMosaicSearchesBboxCroppedToBoundingBox
 * **Example:** GetMosaicSearchesBboxCroppedToBoundingBox from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicSearchesBboxCroppedToBoundingBox = yield* Azure.PlanetaryComputer.GetMosaicSearchesBboxCroppedToBoundingBox(catalog);
 *
 * // runtime
 * const result = yield* getMosaicSearchesBboxCroppedToBoundingBox(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicSearchesBboxCroppedToBoundingBoxHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicSearchesBboxCroppedToBoundingBox extends Binding.Service<
  GetMosaicSearchesBboxCroppedToBoundingBox,
  "Azure.PlanetaryComputer.GetMosaicSearchesBboxCroppedToBoundingBox",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicSearchesBboxCroppedToBoundingBoxRequest,
    ) => Effect.Effect<
      geocatalog.GetMosaicSearchesBboxCroppedToBoundingBoxResponse,
      geocatalog.GetMosaicSearchesBboxCroppedToBoundingBoxError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicSearchesBboxCroppedToBoundingBox =
  Binding.Service<GetMosaicSearchesBboxCroppedToBoundingBox>(
    "Azure.PlanetaryComputer.GetMosaicSearchesBboxCroppedToBoundingBox",
  );
