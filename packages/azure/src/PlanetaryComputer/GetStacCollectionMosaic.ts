import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetStacCollectionMosaic` request without `endpoint`, which the bound
 * GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetStacCollectionMosaicRequest extends Omit<
  geocatalog.GetStacCollectionMosaicRequest,
  "endpoint"
> {}

/**
 * Get Collection Mosaic Get a mosaic definition from a given collection.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetStacCollectionMosaicHttp}.
 *
 * ### Calling GetStacCollectionMosaic
 * **Example:** GetStacCollectionMosaic from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getStacCollectionMosaic = yield* Azure.PlanetaryComputer.GetStacCollectionMosaic(catalog);
 *
 * // runtime
 * const result = yield* getStacCollectionMosaic(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetStacCollectionMosaicHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetStacCollectionMosaic extends Binding.Service<
  GetStacCollectionMosaic,
  "Azure.PlanetaryComputer.GetStacCollectionMosaic",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetStacCollectionMosaicRequest,
    ) => Effect.Effect<
      geocatalog.StacMosaic,
      geocatalog.GetStacCollectionMosaicError,
      RuntimeContext
    >
  >
> {}

export const GetStacCollectionMosaic = Binding.Service<GetStacCollectionMosaic>(
  "Azure.PlanetaryComputer.GetStacCollectionMosaic",
);
