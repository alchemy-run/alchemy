import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicSearchesWmtsTileMatrixSetCapabilitiesXml` request without
 * `endpoint`, which the bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicSearchesWmtsTileMatrixSetCapabilitiesXmlRequest extends Omit<
  geocatalog.GetMosaicSearchesWmtsTileMatrixSetCapabilitiesXmlRequest,
  "endpoint"
> {}

/**
 * Searches Wmts Tilematrixsetid As Path OGC WMTS endpoint with TileMatrixSetId
 * as path.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicSearchesWmtsTileMatrixSetCapabilitiesXmlHttp}.
 *
 * ### Calling GetMosaicSearchesWmtsTileMatrixSetCapabilitiesXml
 * **Example:** GetMosaicSearchesWmtsTileMatrixSetCapabilitiesXml from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicSearchesWmtsTileMatrixSetCapabilitiesXml = yield* Azure.PlanetaryComputer.GetMosaicSearchesWmtsTileMatrixSetCapabilitiesXml(catalog);
 *
 * // runtime
 * const result = yield* getMosaicSearchesWmtsTileMatrixSetCapabilitiesXml(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicSearchesWmtsTileMatrixSetCapabilitiesXmlHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicSearchesWmtsTileMatrixSetCapabilitiesXml extends Binding.Service<
  GetMosaicSearchesWmtsTileMatrixSetCapabilitiesXml,
  "Azure.PlanetaryComputer.GetMosaicSearchesWmtsTileMatrixSetCapabilitiesXml",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicSearchesWmtsTileMatrixSetCapabilitiesXmlRequest,
    ) => Effect.Effect<
      geocatalog.GetMosaicSearchesWmtsTileMatrixSetCapabilitiesXmlResponse,
      geocatalog.GetMosaicSearchesWmtsTileMatrixSetCapabilitiesXmlError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicSearchesWmtsTileMatrixSetCapabilitiesXml =
  Binding.Service<GetMosaicSearchesWmtsTileMatrixSetCapabilitiesXml>(
    "Azure.PlanetaryComputer.GetMosaicSearchesWmtsTileMatrixSetCapabilitiesXml",
  );
