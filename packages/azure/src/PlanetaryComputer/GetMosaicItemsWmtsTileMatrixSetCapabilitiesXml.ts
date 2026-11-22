import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetMosaicItemsWmtsTileMatrixSetCapabilitiesXml` request without `endpoint`,
 * which the bound GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetMosaicItemsWmtsTileMatrixSetCapabilitiesXmlRequest extends Omit<
  geocatalog.GetMosaicItemsWmtsTileMatrixSetCapabilitiesXmlRequest,
  "endpoint"
> {}

/**
 * Item Wmts Tilematrixsetid As Path OGC WMTS endpoint for a STAC item with
 * TileMatrixSetId as path.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMosaicItemsWmtsTileMatrixSetCapabilitiesXmlHttp}.
 *
 * ### Calling GetMosaicItemsWmtsTileMatrixSetCapabilitiesXml
 * **Example:** GetMosaicItemsWmtsTileMatrixSetCapabilitiesXml from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getMosaicItemsWmtsTileMatrixSetCapabilitiesXml = yield* Azure.PlanetaryComputer.GetMosaicItemsWmtsTileMatrixSetCapabilitiesXml(catalog);
 *
 * // runtime
 * const result = yield* getMosaicItemsWmtsTileMatrixSetCapabilitiesXml(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetMosaicItemsWmtsTileMatrixSetCapabilitiesXmlHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetMosaicItemsWmtsTileMatrixSetCapabilitiesXml extends Binding.Service<
  GetMosaicItemsWmtsTileMatrixSetCapabilitiesXml,
  "Azure.PlanetaryComputer.GetMosaicItemsWmtsTileMatrixSetCapabilitiesXml",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetMosaicItemsWmtsTileMatrixSetCapabilitiesXmlRequest,
    ) => Effect.Effect<
      geocatalog.GetMosaicItemsWmtsTileMatrixSetCapabilitiesXmlResponse,
      geocatalog.GetMosaicItemsWmtsTileMatrixSetCapabilitiesXmlError,
      RuntimeContext
    >
  >
> {}

export const GetMosaicItemsWmtsTileMatrixSetCapabilitiesXml =
  Binding.Service<GetMosaicItemsWmtsTileMatrixSetCapabilitiesXml>(
    "Azure.PlanetaryComputer.GetMosaicItemsWmtsTileMatrixSetCapabilitiesXml",
  );
