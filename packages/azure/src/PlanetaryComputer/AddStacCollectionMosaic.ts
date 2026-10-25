import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `AddStacCollectionMosaic` request without `endpoint`, which the bound
 * GeoCatalog (its `catalogUri`) supplies.
 */
export interface AddStacCollectionMosaicRequest extends Omit<
  geocatalog.AddStacCollectionMosaicRequest,
  "endpoint"
> {}

/**
 * Add Collection Mosaic Add a mosaic definition to a given collection.
 *
 * Binding assigns the built-in **GeoCatalog Administrator** role on the bound
 * catalog only: the only role the GeoCatalog data plane accepts for writes
 * (`Microsoft.Orbital` has no data actions, so no narrower custom role exists).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link AddStacCollectionMosaicHttp}.
 *
 * ### Calling AddStacCollectionMosaic
 * **Example:** AddStacCollectionMosaic from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const addStacCollectionMosaic = yield* Azure.PlanetaryComputer.AddStacCollectionMosaic(catalog);
 *
 * // runtime
 * const result = yield* addStacCollectionMosaic(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.AddStacCollectionMosaicHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface AddStacCollectionMosaic extends Binding.Service<
  AddStacCollectionMosaic,
  "Azure.PlanetaryComputer.AddStacCollectionMosaic",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: AddStacCollectionMosaicRequest,
    ) => Effect.Effect<
      geocatalog.StacMosaic,
      geocatalog.AddStacCollectionMosaicError,
      RuntimeContext
    >
  >
> {}

export const AddStacCollectionMosaic = Binding.Service<AddStacCollectionMosaic>(
  "Azure.PlanetaryComputer.AddStacCollectionMosaic",
);
