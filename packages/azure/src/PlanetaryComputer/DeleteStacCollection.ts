import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `DeleteStacCollection` request without `endpoint`, which the bound GeoCatalog
 * (its `catalogUri`) supplies.
 */
export interface DeleteStacCollectionRequest extends Omit<
  geocatalog.DeleteStacCollectionRequest,
  "endpoint"
> {}

/**
 * Delete Collection Delete a collection in the GeoCatalog instance.
 *
 * Binding assigns the built-in **GeoCatalog Administrator** role on the bound
 * catalog only: the only role the GeoCatalog data plane accepts for writes
 * (`Microsoft.Orbital` has no data actions, so no narrower custom role exists).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link DeleteStacCollectionHttp}.
 *
 * ### Calling DeleteStacCollection
 * **Example:** DeleteStacCollection from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const deleteStacCollection = yield* Azure.PlanetaryComputer.DeleteStacCollection(catalog);
 *
 * // runtime
 * const result = yield* deleteStacCollection({ collectionId: "sentinel-2" });
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.DeleteStacCollectionHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface DeleteStacCollection extends Binding.Service<
  DeleteStacCollection,
  "Azure.PlanetaryComputer.DeleteStacCollection",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: DeleteStacCollectionRequest,
    ) => Effect.Effect<
      geocatalog.DeleteStacCollectionResponse,
      geocatalog.DeleteStacCollectionError,
      RuntimeContext
    >
  >
> {}

export const DeleteStacCollection = Binding.Service<DeleteStacCollection>(
  "Azure.PlanetaryComputer.DeleteStacCollection",
);
