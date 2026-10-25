import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetStacLandingPage` request without `endpoint`, which the bound GeoCatalog
 * (its `catalogUri`) supplies.
 */
export interface GetStacLandingPageRequest extends Omit<
  geocatalog.GetStacLandingPageRequest,
  "endpoint"
> {}

/**
 * Read the catalog's STAC landing page (`GET /stac`).
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetStacLandingPageHttp}.
 *
 * ### Calling GetStacLandingPage
 * **Example:** GetStacLandingPage from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getStacLandingPage = yield* Azure.PlanetaryComputer.GetStacLandingPage(catalog);
 *
 * // runtime
 * const result = yield* getStacLandingPage();
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetStacLandingPageHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetStacLandingPage extends Binding.Service<
  GetStacLandingPage,
  "Azure.PlanetaryComputer.GetStacLandingPage",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request?: GetStacLandingPageRequest,
    ) => Effect.Effect<
      geocatalog.StacLandingPage,
      geocatalog.GetStacLandingPageError,
      RuntimeContext
    >
  >
> {}

export const GetStacLandingPage = Binding.Service<GetStacLandingPage>(
  "Azure.PlanetaryComputer.GetStacLandingPage",
);
