import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicSearchesWmtsTileMatrixSetCapabilitiesXml } from "./GetMosaicSearchesWmtsTileMatrixSetCapabilitiesXml.ts";

/**
 * Implementation of {@link GetMosaicSearchesWmtsTileMatrixSetCapabilitiesXml}
 * over the distilled `orbital-planetary-computer` data plane. Assigns
 * **GeoCatalog Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicSearchesWmtsTileMatrixSetCapabilitiesXml
 */
export const GetMosaicSearchesWmtsTileMatrixSetCapabilitiesXmlHttp = Layer.effect(
  GetMosaicSearchesWmtsTileMatrixSetCapabilitiesXml,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicSearchesWmtsTileMatrixSetCapabilitiesXml",
    operation: geocatalog.GetMosaicSearchesWmtsTileMatrixSetCapabilitiesXml,
    grant: GeoCatalogRole.Reader,
  }),
);
