import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `ReplaceStacCollectionAsset` request without `endpoint`, which the bound
 * GeoCatalog (its `catalogUri`) supplies.
 */
export interface ReplaceStacCollectionAssetRequest extends Omit<
  geocatalog.ReplaceStacCollectionAssetRequest,
  "endpoint"
> {}

/**
 * Update Collection Asset Update an existing asset in a given collection.
 *
 * Binding assigns the built-in **GeoCatalog Administrator** role on the bound
 * catalog only: the only role the GeoCatalog data plane accepts for writes
 * (`Microsoft.Orbital` has no data actions, so no narrower custom role exists).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link ReplaceStacCollectionAssetHttp}.
 *
 * ### Calling ReplaceStacCollectionAsset
 * **Example:** ReplaceStacCollectionAsset from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const replaceStacCollectionAsset = yield* Azure.PlanetaryComputer.ReplaceStacCollectionAsset(catalog);
 *
 * // runtime
 * const result = yield* replaceStacCollectionAsset(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.ReplaceStacCollectionAssetHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface ReplaceStacCollectionAsset extends Binding.Service<
  ReplaceStacCollectionAsset,
  "Azure.PlanetaryComputer.ReplaceStacCollectionAsset",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: ReplaceStacCollectionAssetRequest,
    ) => Effect.Effect<
      geocatalog.StacCollection,
      geocatalog.ReplaceStacCollectionAssetError,
      RuntimeContext
    >
  >
> {}

export const ReplaceStacCollectionAsset = Binding.Service<ReplaceStacCollectionAsset>(
  "Azure.PlanetaryComputer.ReplaceStacCollectionAsset",
);
