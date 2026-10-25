import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetStacCollectionRenderOption` request without `endpoint`, which the bound
 * GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetStacCollectionRenderOptionRequest extends Omit<
  geocatalog.GetStacCollectionRenderOptionRequest,
  "endpoint"
> {}

/**
 * Get Collection Render Option Get a render option for a given collection.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetStacCollectionRenderOptionHttp}.
 *
 * ### Calling GetStacCollectionRenderOption
 * **Example:** GetStacCollectionRenderOption from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getStacCollectionRenderOption = yield* Azure.PlanetaryComputer.GetStacCollectionRenderOption(catalog);
 *
 * // runtime
 * const result = yield* getStacCollectionRenderOption(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetStacCollectionRenderOptionHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetStacCollectionRenderOption extends Binding.Service<
  GetStacCollectionRenderOption,
  "Azure.PlanetaryComputer.GetStacCollectionRenderOption",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetStacCollectionRenderOptionRequest,
    ) => Effect.Effect<
      geocatalog.RenderOption,
      geocatalog.GetStacCollectionRenderOptionError,
      RuntimeContext
    >
  >
> {}

export const GetStacCollectionRenderOption = Binding.Service<GetStacCollectionRenderOption>(
  "Azure.PlanetaryComputer.GetStacCollectionRenderOption",
);
