import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `ReplaceStacCollection` request without `endpoint`, which the bound
 * GeoCatalog (its `catalogUri`) supplies.
 */
export interface ReplaceStacCollectionRequest extends Omit<
  geocatalog.ReplaceStacCollectionRequest,
  "endpoint"
> {}

/**
 * Replace Collection Replace an existing collection in the GeoCatalog instance.
 *
 * Binding assigns the built-in **GeoCatalog Administrator** role on the bound
 * catalog only: the only role the GeoCatalog data plane accepts for writes
 * (`Microsoft.Orbital` has no data actions, so no narrower custom role exists).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link ReplaceStacCollectionHttp}.
 *
 * ### Calling ReplaceStacCollection
 * **Example:** ReplaceStacCollection from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const replaceStacCollection = yield* Azure.PlanetaryComputer.ReplaceStacCollection(catalog);
 *
 * // runtime
 * const result = yield* replaceStacCollection(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.ReplaceStacCollectionHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface ReplaceStacCollection extends Binding.Service<
  ReplaceStacCollection,
  "Azure.PlanetaryComputer.ReplaceStacCollection",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: ReplaceStacCollectionRequest,
    ) => Effect.Effect<
      geocatalog.StacCollection,
      geocatalog.ReplaceStacCollectionError,
      RuntimeContext
    >
  >
> {}

export const ReplaceStacCollection = Binding.Service<ReplaceStacCollection>(
  "Azure.PlanetaryComputer.ReplaceStacCollection",
);
