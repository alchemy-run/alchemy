import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `DeleteStacCollectionRenderOption` request without `endpoint`, which the
 * bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface DeleteStacCollectionRenderOptionRequest extends Omit<
  geocatalog.DeleteStacCollectionRenderOptionRequest,
  "endpoint"
> {}

/**
 * Delete Collection Render Option Delete a render option for a given
 * collection.
 *
 * Binding assigns the built-in **GeoCatalog Administrator** role on the bound
 * catalog only: the only role the GeoCatalog data plane accepts for writes
 * (`Microsoft.Orbital` has no data actions, so no narrower custom role exists).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link DeleteStacCollectionRenderOptionHttp}.
 *
 * ### Calling DeleteStacCollectionRenderOption
 * **Example:** DeleteStacCollectionRenderOption from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const deleteStacCollectionRenderOption = yield* Azure.PlanetaryComputer.DeleteStacCollectionRenderOption(catalog);
 *
 * // runtime
 * const result = yield* deleteStacCollectionRenderOption(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.DeleteStacCollectionRenderOptionHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface DeleteStacCollectionRenderOption extends Binding.Service<
  DeleteStacCollectionRenderOption,
  "Azure.PlanetaryComputer.DeleteStacCollectionRenderOption",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: DeleteStacCollectionRenderOptionRequest,
    ) => Effect.Effect<
      geocatalog.DeleteStacCollectionRenderOptionResponse,
      geocatalog.DeleteStacCollectionRenderOptionError,
      RuntimeContext
    >
  >
> {}

export const DeleteStacCollectionRenderOption = Binding.Service<DeleteStacCollectionRenderOption>(
  "Azure.PlanetaryComputer.DeleteStacCollectionRenderOption",
);
