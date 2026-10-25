import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicCollectionsWmtCapabilitiesXml` request without `endpoint`, which
 * the bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicCollectionsWmtCapabilitiesXmlRequest extends Omit<
  geocatalog.GetMosaicCollectionsWmtCapabilitiesXmlRequest,
  "endpoint"
> {}

/**
 * Collection Wmts OGC WMTS endpoint for a STAC collection.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicCollectionsWmtCapabilitiesXmlHttp}.
 *
 * ### Calling GetMosaicCollectionsWmtCapabilitiesXml
 * **Example:** GetMosaicCollectionsWmtCapabilitiesXml from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicCollectionsWmtCapabilitiesXml = yield* Azure.PlanetaryComputer.GetMosaicCollectionsWmtCapabilitiesXml(catalog);
 *
 * // runtime
 * const result = yield* getMosaicCollectionsWmtCapabilitiesXml(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicCollectionsWmtCapabilitiesXmlHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicCollectionsWmtCapabilitiesXml extends Binding.Service<
  GetMosaicCollectionsWmtCapabilitiesXml,
  "Azure.PlanetaryComputer.GetMosaicCollectionsWmtCapabilitiesXml",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicCollectionsWmtCapabilitiesXmlRequest,
    ) => Effect.Effect<
      geocatalog.GetMosaicCollectionsWmtCapabilitiesXmlResponse,
      geocatalog.GetMosaicCollectionsWmtCapabilitiesXmlError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicCollectionsWmtCapabilitiesXml =
  Binding.Service<GetMosaicCollectionsWmtCapabilitiesXml>(
    "Azure.PlanetaryComputer.GetMosaicCollectionsWmtCapabilitiesXml",
  );
