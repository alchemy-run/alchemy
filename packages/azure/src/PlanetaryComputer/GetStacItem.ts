import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetStacItem` request without `endpoint`, which the bound GeoCatalog (its
 * `catalogUri`) supplies.
 */
export interface GetStacItemRequest extends Omit<geocatalog.GetStacItemRequest, "endpoint"> {}

/**
 * Fetch a single STAC Item.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetStacItemHttp}.
 *
 * ### Calling GetStacItem
 * **Example:** GetStacItem from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getStacItem = yield* Azure.PlanetaryComputer.GetStacItem(catalog);
 *
 * // runtime
 * const result = yield* getStacItem({ collectionId: "sentinel-2", itemId: "S2A_T32TNS_20240101" });
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetStacItemHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetStacItem extends Binding.Service<
  GetStacItem,
  "Azure.PlanetaryComputer.GetStacItem",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetStacItemRequest,
    ) => Effect.Effect<geocatalog.GetStacItemResponse, geocatalog.GetStacItemError, RuntimeContext>
  >
> {}

export const GetStacItem = Binding.Service<GetStacItem>("Azure.PlanetaryComputer.GetStacItem");
