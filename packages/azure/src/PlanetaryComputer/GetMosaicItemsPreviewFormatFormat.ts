import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicItemsPreviewFormatFormat` request without `endpoint`, which the
 * bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicItemsPreviewFormatFormatRequest extends Omit<
  geocatalog.GetMosaicItemsPreviewFormatFormatRequest,
  "endpoint"
> {}

/**
 * Item Preview With Format Create preview of a STAC item dataset with format.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicItemsPreviewFormatFormatHttp}.
 *
 * ### Calling GetMosaicItemsPreviewFormatFormat
 * **Example:** GetMosaicItemsPreviewFormatFormat from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicItemsPreviewFormatFormat = yield* Azure.PlanetaryComputer.GetMosaicItemsPreviewFormatFormat(catalog);
 *
 * // runtime
 * const result = yield* getMosaicItemsPreviewFormatFormat(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicItemsPreviewFormatFormatHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicItemsPreviewFormatFormat extends Binding.Service<
  GetMosaicItemsPreviewFormatFormat,
  "Azure.PlanetaryComputer.GetMosaicItemsPreviewFormatFormat",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicItemsPreviewFormatFormatRequest,
    ) => Effect.Effect<
      geocatalog.GetMosaicItemsPreviewFormatFormatResponse,
      geocatalog.GetMosaicItemsPreviewFormatFormatError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicItemsPreviewFormatFormat = Binding.Service<GetMosaicItemsPreviewFormatFormat>(
  "Azure.PlanetaryComputer.GetMosaicItemsPreviewFormatFormat",
);
