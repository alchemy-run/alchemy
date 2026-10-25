import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicItemsPreview` request without `endpoint`, which the bound
 * GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicItemsPreviewRequest extends Omit<
  geocatalog.GetMosaicItemsPreviewRequest,
  "endpoint"
> {}

/**
 * Item Preview Create preview of a STAC item dataset.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicItemsPreviewHttp}.
 *
 * ### Calling GetMosaicItemsPreview
 * **Example:** GetMosaicItemsPreview from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicItemsPreview = yield* Azure.PlanetaryComputer.GetMosaicItemsPreview(catalog);
 *
 * // runtime
 * const result = yield* getMosaicItemsPreview(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicItemsPreviewHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicItemsPreview extends Binding.Service<
  GetMosaicItemsPreview,
  "Azure.PlanetaryComputer.GetMosaicItemsPreview",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicItemsPreviewRequest,
    ) => Effect.Effect<
      geocatalog.GetMosaicItemsPreviewResponse,
      geocatalog.GetMosaicItemsPreviewError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicItemsPreview = Binding.Service<GetMosaicItemsPreview>(
  "Azure.PlanetaryComputer.GetMosaicItemsPreview",
);
