import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `ReplaceStacCollectionPartitionType` request without `endpoint`, which the
 * bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface ReplaceStacCollectionPartitionTypeRequest extends Omit<
  geocatalog.ReplaceStacCollectionPartitionTypeRequest,
  "endpoint"
> {}

/**
 * Create Partitiontype Updates partition type for a GeoCatalog Collection.
 *
 * Binding assigns the built-in **GeoCatalog Administrator** role on the bound
 * catalog only: the only role the GeoCatalog data plane accepts for writes
 * (`Microsoft.Orbital` has no data actions, so no narrower custom role exists).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link ReplaceStacCollectionPartitionTypeHttp}.
 *
 * ### Calling ReplaceStacCollectionPartitionType
 * **Example:** ReplaceStacCollectionPartitionType from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const replaceStacCollectionPartitionType = yield* Azure.PlanetaryComputer.ReplaceStacCollectionPartitionType(catalog);
 *
 * // runtime
 * const result = yield* replaceStacCollectionPartitionType(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.ReplaceStacCollectionPartitionTypeHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface ReplaceStacCollectionPartitionType extends Binding.Service<
  ReplaceStacCollectionPartitionType,
  "Azure.PlanetaryComputer.ReplaceStacCollectionPartitionType",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: ReplaceStacCollectionPartitionTypeRequest,
    ) => Effect.Effect<
      geocatalog.ReplaceStacCollectionPartitionTypeResponse,
      geocatalog.ReplaceStacCollectionPartitionTypeError,
      RuntimeContext
    >
  >
> {}

export const ReplaceStacCollectionPartitionType =
  Binding.Service<ReplaceStacCollectionPartitionType>(
    "Azure.PlanetaryComputer.ReplaceStacCollectionPartitionType",
  );
