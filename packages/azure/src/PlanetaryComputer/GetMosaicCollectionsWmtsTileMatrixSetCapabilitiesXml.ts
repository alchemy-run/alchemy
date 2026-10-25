import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicCollectionsWmtsTileMatrixSetCapabilitiesXml` request without
 * `endpoint`, which the bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicCollectionsWmtsTileMatrixSetCapabilitiesXmlRequest extends Omit<
  geocatalog.GetMosaicCollectionsWmtsTileMatrixSetCapabilitiesXmlRequest,
  "endpoint"
> {}

/**
 * Collection Wmts Tilematrixsetid As Path OGC WMTS endpoint for a STAC
 * collection with TileMatrixSetId as path.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicCollectionsWmtsTileMatrixSetCapabilitiesXmlHttp}.
 *
 * ### Calling GetMosaicCollectionsWmtsTileMatrixSetCapabilitiesXml
 * **Example:** GetMosaicCollectionsWmtsTileMatrixSetCapabilitiesXml from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicCollectionsWmtsTileMatrixSetCapabilitiesXml = yield* Azure.PlanetaryComputer.GetMosaicCollectionsWmtsTileMatrixSetCapabilitiesXml(catalog);
 *
 * // runtime
 * const result = yield* getMosaicCollectionsWmtsTileMatrixSetCapabilitiesXml(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicCollectionsWmtsTileMatrixSetCapabilitiesXmlHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicCollectionsWmtsTileMatrixSetCapabilitiesXml extends Binding.Service<
  GetMosaicCollectionsWmtsTileMatrixSetCapabilitiesXml,
  "Azure.PlanetaryComputer.GetMosaicCollectionsWmtsTileMatrixSetCapabilitiesXml",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicCollectionsWmtsTileMatrixSetCapabilitiesXmlRequest,
    ) => Effect.Effect<
      geocatalog.GetMosaicCollectionsWmtsTileMatrixSetCapabilitiesXmlResponse,
      geocatalog.GetMosaicCollectionsWmtsTileMatrixSetCapabilitiesXmlError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicCollectionsWmtsTileMatrixSetCapabilitiesXml =
  Binding.Service<GetMosaicCollectionsWmtsTileMatrixSetCapabilitiesXml>(
    "Azure.PlanetaryComputer.GetMosaicCollectionsWmtsTileMatrixSetCapabilitiesXml",
  );
