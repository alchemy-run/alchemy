import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetStacCollectionConfig` request without `endpoint`, which the bound
 * GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetStacCollectionConfigRequest extends Omit<
  geocatalog.GetStacCollectionConfigRequest,
  "endpoint"
> {}

/**
 * Get Config Get the complete user configuration for a given collection.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetStacCollectionConfigHttp}.
 *
 * ### Calling GetStacCollectionConfig
 * **Example:** GetStacCollectionConfig from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getStacCollectionConfig = yield* Azure.PlanetaryComputer.GetStacCollectionConfig(catalog);
 *
 * // runtime
 * const result = yield* getStacCollectionConfig(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetStacCollectionConfigHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetStacCollectionConfig extends Binding.Service<
  GetStacCollectionConfig,
  "Azure.PlanetaryComputer.GetStacCollectionConfig",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetStacCollectionConfigRequest,
    ) => Effect.Effect<
      geocatalog.UserCollectionSettings,
      geocatalog.GetStacCollectionConfigError,
      RuntimeContext
    >
  >
> {}

export const GetStacCollectionConfig = Binding.Service<GetStacCollectionConfig>(
  "Azure.PlanetaryComputer.GetStacCollectionConfig",
);
