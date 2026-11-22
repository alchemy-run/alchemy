import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `ReplaceStacItem` request without `endpoint`, which the bound GeoCatalog (its
 * `catalogUri`) supplies.
 */
export interface ReplaceStacItemRequest extends Omit<
  geocatalog.ReplaceStacItemRequest,
  "endpoint"
> {}

/**
 * Replace a STAC item in a collection.
 *
 * Binding assigns the built-in **GeoCatalog Administrator** role on the bound
 * catalog only: the only role the GeoCatalog data plane accepts for writes
 * (`Microsoft.Orbital` has no data actions, so no narrower custom role exists).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link ReplaceStacItemHttp}.
 *
 * ### Calling ReplaceStacItem
 * **Example:** ReplaceStacItem from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const replaceStacItem = yield* Azure.PlanetaryComputer.ReplaceStacItem(catalog);
 *
 * // runtime
 * const result = yield* replaceStacItem({ collectionId: "sentinel-2", itemId: feature.id, ...feature });
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.ReplaceStacItemHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface ReplaceStacItem extends Binding.Service<
  ReplaceStacItem,
  "Azure.PlanetaryComputer.ReplaceStacItem",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: ReplaceStacItemRequest,
    ) => Effect.Effect<
      geocatalog.ReplaceStacItemResponse,
      geocatalog.ReplaceStacItemError,
      RuntimeContext
    >
  >
> {}

export const ReplaceStacItem = Binding.Service<ReplaceStacItem>(
  "Azure.PlanetaryComputer.ReplaceStacItem",
);
