import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `CreateStacCollectionAsset` request without `endpoint`, which the bound
 * GeoCatalog (its `catalogUri`) supplies.
 */
export interface CreateStacCollectionAssetRequest extends Omit<
  geocatalog.CreateStacCollectionAssetRequest,
  "endpoint"
> {}

/**
 * Create Collection Asset Create a new asset in the Collection metadata and
 * write the associated file to managed storage.
 *
 * Binding assigns the built-in **GeoCatalog Administrator** role on the bound
 * catalog only: the only role the GeoCatalog data plane accepts for writes
 * (`Microsoft.Orbital` has no data actions, so no narrower custom role exists).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link CreateStacCollectionAssetHttp}.
 *
 * ### Calling CreateStacCollectionAsset
 * **Example:** CreateStacCollectionAsset from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const createStacCollectionAsset = yield* Azure.PlanetaryComputer.CreateStacCollectionAsset(catalog);
 *
 * // runtime
 * const result = yield* createStacCollectionAsset(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.CreateStacCollectionAssetHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface CreateStacCollectionAsset extends Binding.Service<
  CreateStacCollectionAsset,
  "Azure.PlanetaryComputer.CreateStacCollectionAsset",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: CreateStacCollectionAssetRequest,
    ) => Effect.Effect<
      geocatalog.StacCollection,
      geocatalog.CreateStacCollectionAssetError,
      RuntimeContext
    >
  >
> {}

export const CreateStacCollectionAsset = Binding.Service<CreateStacCollectionAsset>(
  "Azure.PlanetaryComputer.CreateStacCollectionAsset",
);
