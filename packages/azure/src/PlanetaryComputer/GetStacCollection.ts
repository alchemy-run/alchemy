import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetStacCollection` request without `endpoint`, which the bound GeoCatalog
 * (its `catalogUri`) supplies.
 */
export interface GetStacCollectionRequest extends Omit<
  geocatalog.GetStacCollectionRequest,
  "endpoint"
> {}

/**
 * Get Collection Get a collection in the GeoCatalog instance.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetStacCollectionHttp}.
 *
 * ### Calling GetStacCollection
 * **Example:** GetStacCollection from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getStacCollection = yield* Azure.PlanetaryComputer.GetStacCollection(catalog);
 *
 * // runtime
 * const result = yield* getStacCollection({ collectionId: "sentinel-2" });
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetStacCollectionHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetStacCollection extends Binding.Service<
  GetStacCollection,
  "Azure.PlanetaryComputer.GetStacCollection",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetStacCollectionRequest,
    ) => Effect.Effect<geocatalog.StacCollection, geocatalog.GetStacCollectionError, RuntimeContext>
  >
> {}

export const GetStacCollection = Binding.Service<GetStacCollection>(
  "Azure.PlanetaryComputer.GetStacCollection",
);
