import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `CreateStacCollection` request without `endpoint`, which the bound GeoCatalog
 * (its `catalogUri`) supplies.
 */
export interface CreateStacCollectionRequest extends Omit<
  geocatalog.CreateStacCollectionRequest,
  "endpoint"
> {}

/**
 * Create Collection Create a new collection in the GeoCatalog instance.
 *
 * Binding assigns the built-in **GeoCatalog Administrator** role on the bound
 * catalog only: the only role the GeoCatalog data plane accepts for writes
 * (`Microsoft.Orbital` has no data actions, so no narrower custom role exists).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link CreateStacCollectionHttp}.
 *
 * ### Calling CreateStacCollection
 * **Example:** CreateStacCollection from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const createStacCollection = yield* Azure.PlanetaryComputer.CreateStacCollection(catalog);
 *
 * // runtime
 * const result = yield* createStacCollection({ id: "sentinel-2", description: "Sentinel-2 L2A", license: "proprietary", links: [], extent });
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.CreateStacCollectionHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface CreateStacCollection extends Binding.Service<
  CreateStacCollection,
  "Azure.PlanetaryComputer.CreateStacCollection",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: CreateStacCollectionRequest,
    ) => Effect.Effect<
      geocatalog.CreateStacCollectionResponse,
      geocatalog.CreateStacCollectionError,
      RuntimeContext
    >
  >
> {}

export const CreateStacCollection = Binding.Service<CreateStacCollection>(
  "Azure.PlanetaryComputer.CreateStacCollection",
);
