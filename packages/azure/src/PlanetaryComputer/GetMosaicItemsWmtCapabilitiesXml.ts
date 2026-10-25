import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicItemsWmtCapabilitiesXml` request without `endpoint`, which the
 * bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicItemsWmtCapabilitiesXmlRequest extends Omit<
  geocatalog.GetMosaicItemsWmtCapabilitiesXmlRequest,
  "endpoint"
> {}

/**
 * Item Wmts OGC WMTS endpoint for a STAC item.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicItemsWmtCapabilitiesXmlHttp}.
 *
 * ### Calling GetMosaicItemsWmtCapabilitiesXml
 * **Example:** GetMosaicItemsWmtCapabilitiesXml from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicItemsWmtCapabilitiesXml = yield* Azure.PlanetaryComputer.GetMosaicItemsWmtCapabilitiesXml(catalog);
 *
 * // runtime
 * const result = yield* getMosaicItemsWmtCapabilitiesXml(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicItemsWmtCapabilitiesXmlHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicItemsWmtCapabilitiesXml extends Binding.Service<
  GetMosaicItemsWmtCapabilitiesXml,
  "Azure.PlanetaryComputer.GetMosaicItemsWmtCapabilitiesXml",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicItemsWmtCapabilitiesXmlRequest,
    ) => Effect.Effect<
      geocatalog.GetMosaicItemsWmtCapabilitiesXmlResponse,
      geocatalog.GetMosaicItemsWmtCapabilitiesXmlError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicItemsWmtCapabilitiesXml = Binding.Service<GetMosaicItemsWmtCapabilitiesXml>(
  "Azure.PlanetaryComputer.GetMosaicItemsWmtCapabilitiesXml",
);
