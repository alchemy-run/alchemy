import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `CreateStacCollectionRenderOption` request without `endpoint`, which the
 * bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface CreateStacCollectionRenderOptionRequest extends Omit<
  geocatalog.CreateStacCollectionRenderOptionRequest,
  "endpoint"
> {}

/**
 * Add Collection Render Option Add a render option for a given collection.
 *
 * Binding assigns the built-in **GeoCatalog Administrator** role on the bound
 * catalog only: the only role the GeoCatalog data plane accepts for writes
 * (`Microsoft.Orbital` has no data actions, so no narrower custom role exists).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link CreateStacCollectionRenderOptionHttp}.
 *
 * ### Calling CreateStacCollectionRenderOption
 * **Example:** CreateStacCollectionRenderOption from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const createStacCollectionRenderOption = yield* Azure.PlanetaryComputer.CreateStacCollectionRenderOption(catalog);
 *
 * // runtime
 * const result = yield* createStacCollectionRenderOption(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.CreateStacCollectionRenderOptionHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface CreateStacCollectionRenderOption extends Binding.Service<
  CreateStacCollectionRenderOption,
  "Azure.PlanetaryComputer.CreateStacCollectionRenderOption",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: CreateStacCollectionRenderOptionRequest,
    ) => Effect.Effect<
      geocatalog.RenderOption,
      geocatalog.CreateStacCollectionRenderOptionError,
      RuntimeContext
    >
  >
> {}

export const CreateStacCollectionRenderOption = Binding.Service<CreateStacCollectionRenderOption>(
  "Azure.PlanetaryComputer.CreateStacCollectionRenderOption",
);
