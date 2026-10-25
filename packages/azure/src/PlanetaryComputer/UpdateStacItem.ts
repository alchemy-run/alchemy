import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `UpdateStacItem` request without `endpoint`, which the bound GeoCatalog (its
 * `catalogUri`) supplies.
 */
export interface UpdateStacItemRequest extends Omit<geocatalog.UpdateStacItemRequest, "endpoint"> {}

/**
 * Update a STAC item in a collection.
 *
 * Binding assigns the built-in **GeoCatalog Administrator** role on the bound
 * catalog only: the only role the GeoCatalog data plane accepts for writes
 * (`Microsoft.Orbital` has no data actions, so no narrower custom role exists).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link UpdateStacItemHttp}.
 *
 * ### Calling UpdateStacItem
 * **Example:** UpdateStacItem from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const updateStacItem = yield* Azure.PlanetaryComputer.UpdateStacItem(catalog);
 *
 * // runtime
 * const result = yield* updateStacItem({ collectionId: "sentinel-2", itemId: "S2A_T32TNS_20240101", type: "Feature", properties: { datetime: "2024-01-01T00:00:00Z" } });
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.UpdateStacItemHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface UpdateStacItem extends Binding.Service<
  UpdateStacItem,
  "Azure.PlanetaryComputer.UpdateStacItem",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: UpdateStacItemRequest,
    ) => Effect.Effect<
      geocatalog.UpdateStacItemResponse,
      geocatalog.UpdateStacItemError,
      RuntimeContext
    >
  >
> {}

export const UpdateStacItem = Binding.Service<UpdateStacItem>(
  "Azure.PlanetaryComputer.UpdateStacItem",
);
