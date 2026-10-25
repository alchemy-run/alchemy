import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `DeleteStacCollectionAsset` request without `endpoint`, which the bound
 * GeoCatalog (its `catalogUri`) supplies.
 */
export interface DeleteStacCollectionAssetRequest extends Omit<
  geocatalog.DeleteStacCollectionAssetRequest,
  "endpoint"
> {}

/**
 * Delete Collection Asset Delete an asset from a given collection.
 *
 * Binding assigns the built-in **GeoCatalog Administrator** role on the bound
 * catalog only: the only role the GeoCatalog data plane accepts for writes
 * (`Microsoft.Orbital` has no data actions, so no narrower custom role exists).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link DeleteStacCollectionAssetHttp}.
 *
 * ### Calling DeleteStacCollectionAsset
 * **Example:** DeleteStacCollectionAsset from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const deleteStacCollectionAsset = yield* Azure.PlanetaryComputer.DeleteStacCollectionAsset(catalog);
 *
 * // runtime
 * const result = yield* deleteStacCollectionAsset(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.DeleteStacCollectionAssetHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface DeleteStacCollectionAsset extends Binding.Service<
  DeleteStacCollectionAsset,
  "Azure.PlanetaryComputer.DeleteStacCollectionAsset",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: DeleteStacCollectionAssetRequest,
    ) => Effect.Effect<
      geocatalog.StacCollection,
      geocatalog.DeleteStacCollectionAssetError,
      RuntimeContext
    >
  >
> {}

export const DeleteStacCollectionAsset = Binding.Service<DeleteStacCollectionAsset>(
  "Azure.PlanetaryComputer.DeleteStacCollectionAsset",
);
