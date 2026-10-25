import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `CreateStacItem` request without `endpoint`, which the bound GeoCatalog (its
 * `catalogUri`) supplies.
 */
export interface CreateStacItemRequest extends Omit<geocatalog.CreateStacItemRequest, "endpoint"> {}

/**
 * Create a new STAC item or a set of items in a collection.
 *
 * Binding assigns the built-in **GeoCatalog Administrator** role on the bound
 * catalog only: the only role the GeoCatalog data plane accepts for writes
 * (`Microsoft.Orbital` has no data actions, so no narrower custom role exists).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link CreateStacItemHttp}.
 *
 * ### Calling CreateStacItem
 * **Example:** CreateStacItem from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const createStacItem = yield* Azure.PlanetaryComputer.CreateStacItem(catalog);
 *
 * // runtime
 * const result = yield* createStacItem({ collectionId: "sentinel-2", ...feature });
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.CreateStacItemHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface CreateStacItem extends Binding.Service<
  CreateStacItem,
  "Azure.PlanetaryComputer.CreateStacItem",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: CreateStacItemRequest,
    ) => Effect.Effect<
      geocatalog.CreateStacItemResponse,
      geocatalog.CreateStacItemError,
      RuntimeContext
    >
  >
> {}

export const CreateStacItem = Binding.Service<CreateStacItem>(
  "Azure.PlanetaryComputer.CreateStacItem",
);
