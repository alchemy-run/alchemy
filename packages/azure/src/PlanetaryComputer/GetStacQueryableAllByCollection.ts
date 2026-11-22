import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetStacQueryableAllByCollection` request without `endpoint`, which the bound
 * GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetStacQueryableAllByCollectionRequest extends Omit<
  geocatalog.GetStacQueryableAllByCollectionRequest,
  "endpoint"
> {}

/**
 * Collection Queryables List all queryables in a given collection.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetStacQueryableAllByCollectionHttp}.
 *
 * ### Calling GetStacQueryableAllByCollection
 * **Example:** GetStacQueryableAllByCollection from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getStacQueryableAllByCollection = yield* Azure.PlanetaryComputer.GetStacQueryableAllByCollection(catalog);
 *
 * // runtime
 * const result = yield* getStacQueryableAllByCollection(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetStacQueryableAllByCollectionHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetStacQueryableAllByCollection extends Binding.Service<
  GetStacQueryableAllByCollection,
  "Azure.PlanetaryComputer.GetStacQueryableAllByCollection",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetStacQueryableAllByCollectionRequest,
    ) => Effect.Effect<
      geocatalog.GetStacQueryableAllByCollectionResponse,
      geocatalog.GetStacQueryableAllByCollectionError,
      RuntimeContext
    >
  >
> {}

export const GetStacQueryableAllByCollection = Binding.Service<GetStacQueryableAllByCollection>(
  "Azure.PlanetaryComputer.GetStacQueryableAllByCollection",
);
