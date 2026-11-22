import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicSearchesWmtCapabilitiesXml` request without `endpoint`, which the
 * bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicSearchesWmtCapabilitiesXmlRequest extends Omit<
  geocatalog.GetMosaicSearchesWmtCapabilitiesXmlRequest,
  "endpoint"
> {}

/**
 * Searches Wmts OGC WMTS endpoint.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicSearchesWmtCapabilitiesXmlHttp}.
 *
 * ### Calling GetMosaicSearchesWmtCapabilitiesXml
 * **Example:** GetMosaicSearchesWmtCapabilitiesXml from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicSearchesWmtCapabilitiesXml = yield* Azure.PlanetaryComputer.GetMosaicSearchesWmtCapabilitiesXml(catalog);
 *
 * // runtime
 * const result = yield* getMosaicSearchesWmtCapabilitiesXml(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicSearchesWmtCapabilitiesXmlHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicSearchesWmtCapabilitiesXml extends Binding.Service<
  GetMosaicSearchesWmtCapabilitiesXml,
  "Azure.PlanetaryComputer.GetMosaicSearchesWmtCapabilitiesXml",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicSearchesWmtCapabilitiesXmlRequest,
    ) => Effect.Effect<
      geocatalog.GetMosaicSearchesWmtCapabilitiesXmlResponse,
      geocatalog.GetMosaicSearchesWmtCapabilitiesXmlError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicSearchesWmtCapabilitiesXml =
  Binding.Service<GetMosaicSearchesWmtCapabilitiesXml>(
    "Azure.PlanetaryComputer.GetMosaicSearchesWmtCapabilitiesXml",
  );
