import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetStacCollectionPartitionType` request without `endpoint`, which the bound
 * GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetStacCollectionPartitionTypeRequest extends Omit<
  geocatalog.GetStacCollectionPartitionTypeRequest,
  "endpoint"
> {}

/**
 * Get Partitiontype Get the partitiontype for a GeoCatalog Collection.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetStacCollectionPartitionTypeHttp}.
 *
 * ### Calling GetStacCollectionPartitionType
 * **Example:** GetStacCollectionPartitionType from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getStacCollectionPartitionType = yield* Azure.PlanetaryComputer.GetStacCollectionPartitionType(catalog);
 *
 * // runtime
 * const result = yield* getStacCollectionPartitionType(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetStacCollectionPartitionTypeHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetStacCollectionPartitionType extends Binding.Service<
  GetStacCollectionPartitionType,
  "Azure.PlanetaryComputer.GetStacCollectionPartitionType",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetStacCollectionPartitionTypeRequest,
    ) => Effect.Effect<
      geocatalog.PartitionType,
      geocatalog.GetStacCollectionPartitionTypeError,
      RuntimeContext
    >
  >
> {}

export const GetStacCollectionPartitionType = Binding.Service<GetStacCollectionPartitionType>(
  "Azure.PlanetaryComputer.GetStacCollectionPartitionType",
);
