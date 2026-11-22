import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `ReplaceStacCollectionRenderOption` request without `endpoint`, which the
 * bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface ReplaceStacCollectionRenderOptionRequest extends Omit<
  geocatalog.ReplaceStacCollectionRenderOptionRequest,
  "endpoint"
> {}

/**
 * Update Collection Render Option Update a render option for a given
 * collection.
 *
 * Binding assigns the built-in **GeoCatalog Administrator** role on the bound
 * catalog only: the only role the GeoCatalog data plane accepts for writes
 * (`Microsoft.Orbital` has no data actions, so no narrower custom role exists).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link ReplaceStacCollectionRenderOptionHttp}.
 *
 * ### Calling ReplaceStacCollectionRenderOption
 * **Example:** ReplaceStacCollectionRenderOption from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const replaceStacCollectionRenderOption = yield* Azure.PlanetaryComputer.ReplaceStacCollectionRenderOption(catalog);
 *
 * // runtime
 * const result = yield* replaceStacCollectionRenderOption(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.ReplaceStacCollectionRenderOptionHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface ReplaceStacCollectionRenderOption extends Binding.Service<
  ReplaceStacCollectionRenderOption,
  "Azure.PlanetaryComputer.ReplaceStacCollectionRenderOption",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: ReplaceStacCollectionRenderOptionRequest,
    ) => Effect.Effect<
      geocatalog.RenderOption,
      geocatalog.ReplaceStacCollectionRenderOptionError,
      RuntimeContext
    >
  >
> {}

export const ReplaceStacCollectionRenderOption = Binding.Service<ReplaceStacCollectionRenderOption>(
  "Azure.PlanetaryComputer.ReplaceStacCollectionRenderOption",
);
