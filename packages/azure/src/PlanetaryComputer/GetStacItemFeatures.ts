import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetStacItemFeatures` request without `endpoint`, which the bound GeoCatalog
 * (its `catalogUri`) supplies.
 */
export interface GetStacItemFeaturesRequest extends Omit<
  geocatalog.GetStacItemFeaturesRequest,
  "endpoint"
> {}

/**
 * List the items of a STAC collection (`GET
 * /stac/collections/{collectionId}/items`).
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetStacItemFeaturesHttp}.
 *
 * ### Calling GetStacItemFeatures
 * **Example:** GetStacItemFeatures from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getStacItemFeatures = yield* Azure.PlanetaryComputer.GetStacItemFeatures(catalog);
 *
 * // runtime
 * const result = yield* getStacItemFeatures({ collectionId: "sentinel-2", limit: 10 });
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetStacItemFeaturesHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetStacItemFeatures extends Binding.Service<
  GetStacItemFeatures,
  "Azure.PlanetaryComputer.GetStacItemFeatures",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetStacItemFeaturesRequest,
    ) => Effect.Effect<
      geocatalog.GetStacItemFeaturesResponse,
      geocatalog.GetStacItemFeaturesError,
      RuntimeContext
    >
  >
> {}

export const GetStacItemFeatures = Binding.Service<GetStacItemFeatures>(
  "Azure.PlanetaryComputer.GetStacItemFeatures",
);
