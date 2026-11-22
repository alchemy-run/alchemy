import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `RegisterMosaicsRegisterSearch` request without `endpoint`, which the bound
 * GeoCatalog (its `catalogUri`) supplies.
 */
export interface RegisterMosaicsRegisterSearchRequest extends Omit<
  geocatalog.RegisterMosaicsRegisterSearchRequest,
  "endpoint"
> {}

/**
 * Register a STAC search for mosaic tiling (`POST /data/mosaic/register`).
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link RegisterMosaicsRegisterSearchHttp}.
 *
 * ### Calling RegisterMosaicsRegisterSearch
 * **Example:** RegisterMosaicsRegisterSearch from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const registerMosaicsRegisterSearch = yield* Azure.PlanetaryComputer.RegisterMosaicsRegisterSearch(catalog);
 *
 * // runtime
 * const result = yield* registerMosaicsRegisterSearch({ collections: ["sentinel-2"] });
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.RegisterMosaicsRegisterSearchHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface RegisterMosaicsRegisterSearch extends Binding.Service<
  RegisterMosaicsRegisterSearch,
  "Azure.PlanetaryComputer.RegisterMosaicsRegisterSearch",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request?: RegisterMosaicsRegisterSearchRequest,
    ) => Effect.Effect<
      geocatalog.TilerMosaicSearchRegistrationResponse,
      geocatalog.RegisterMosaicsRegisterSearchError,
      RuntimeContext
    >
  >
> {}

export const RegisterMosaicsRegisterSearch = Binding.Service<RegisterMosaicsRegisterSearch>(
  "Azure.PlanetaryComputer.RegisterMosaicsRegisterSearch",
);
