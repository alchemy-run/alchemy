import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetStacCollectionMosaicAll` request without `endpoint`, which the bound
 * GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetStacCollectionMosaicAllRequest extends Omit<
  geocatalog.GetStacCollectionMosaicAllRequest,
  "endpoint"
> {}

/**
 * Get Collection Mosaics Get the mosaic definitions for a given collection.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetStacCollectionMosaicAllHttp}.
 *
 * ### Calling GetStacCollectionMosaicAll
 * **Example:** GetStacCollectionMosaicAll from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getStacCollectionMosaicAll = yield* Azure.PlanetaryComputer.GetStacCollectionMosaicAll(catalog);
 *
 * // runtime
 * const result = yield* getStacCollectionMosaicAll(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetStacCollectionMosaicAllHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetStacCollectionMosaicAll extends Binding.Service<
  GetStacCollectionMosaicAll,
  "Azure.PlanetaryComputer.GetStacCollectionMosaicAll",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetStacCollectionMosaicAllRequest,
    ) => Effect.Effect<
      geocatalog.GetStacCollectionMosaicAllResponse,
      geocatalog.GetStacCollectionMosaicAllError,
      RuntimeContext
    >
  >
> {}

export const GetStacCollectionMosaicAll = Binding.Service<GetStacCollectionMosaicAll>(
  "Azure.PlanetaryComputer.GetStacCollectionMosaicAll",
);
