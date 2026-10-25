import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `DeleteStacItem` request without `endpoint`, which the bound GeoCatalog (its
 * `catalogUri`) supplies.
 */
export interface DeleteStacItemRequest extends Omit<geocatalog.DeleteStacItemRequest, "endpoint"> {}

/**
 * Delete a STAC item from a collection.
 *
 * Binding assigns the built-in **GeoCatalog Administrator** role on the bound
 * catalog only: the only role the GeoCatalog data plane accepts for writes
 * (`Microsoft.Orbital` has no data actions, so no narrower custom role exists).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link DeleteStacItemHttp}.
 *
 * ### Calling DeleteStacItem
 * **Example:** DeleteStacItem from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const deleteStacItem = yield* Azure.PlanetaryComputer.DeleteStacItem(catalog);
 *
 * // runtime
 * const result = yield* deleteStacItem({ collectionId: "sentinel-2", itemId: "S2A_T32TNS_20240101" });
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.DeleteStacItemHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface DeleteStacItem extends Binding.Service<
  DeleteStacItem,
  "Azure.PlanetaryComputer.DeleteStacItem",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: DeleteStacItemRequest,
    ) => Effect.Effect<
      geocatalog.DeleteStacItemResponse,
      geocatalog.DeleteStacItemError,
      RuntimeContext
    >
  >
> {}

export const DeleteStacItem = Binding.Service<DeleteStacItem>(
  "Azure.PlanetaryComputer.DeleteStacItem",
);
