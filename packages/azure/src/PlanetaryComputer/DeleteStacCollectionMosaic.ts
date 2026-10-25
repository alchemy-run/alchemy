import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `DeleteStacCollectionMosaic` request without `endpoint`, which the bound
 * GeoCatalog (its `catalogUri`) supplies.
 */
export interface DeleteStacCollectionMosaicRequest extends Omit<
  geocatalog.DeleteStacCollectionMosaicRequest,
  "endpoint"
> {}

/**
 * Delete Collection Mosaic Delete a mosaic definition from a given collection.
 *
 * Binding assigns the built-in **GeoCatalog Administrator** role on the bound
 * catalog only: the only role the GeoCatalog data plane accepts for writes
 * (`Microsoft.Orbital` has no data actions, so no narrower custom role exists).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link DeleteStacCollectionMosaicHttp}.
 *
 * ### Calling DeleteStacCollectionMosaic
 * **Example:** DeleteStacCollectionMosaic from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const deleteStacCollectionMosaic = yield* Azure.PlanetaryComputer.DeleteStacCollectionMosaic(catalog);
 *
 * // runtime
 * const result = yield* deleteStacCollectionMosaic(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.DeleteStacCollectionMosaicHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface DeleteStacCollectionMosaic extends Binding.Service<
  DeleteStacCollectionMosaic,
  "Azure.PlanetaryComputer.DeleteStacCollectionMosaic",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: DeleteStacCollectionMosaicRequest,
    ) => Effect.Effect<
      geocatalog.DeleteStacCollectionMosaicResponse,
      geocatalog.DeleteStacCollectionMosaicError,
      RuntimeContext
    >
  >
> {}

export const DeleteStacCollectionMosaic = Binding.Service<DeleteStacCollectionMosaic>(
  "Azure.PlanetaryComputer.DeleteStacCollectionMosaic",
);
