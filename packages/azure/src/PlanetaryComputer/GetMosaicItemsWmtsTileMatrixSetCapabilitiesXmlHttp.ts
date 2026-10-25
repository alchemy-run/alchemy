import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicItemsWmtsTileMatrixSetCapabilitiesXml } from "./GetMosaicItemsWmtsTileMatrixSetCapabilitiesXml.ts";

/**
 * Implementation of {@link GetMosaicItemsWmtsTileMatrixSetCapabilitiesXml} over
 * the distilled `orbital-planetary-computer` data plane. Assigns **GeoCatalog
 * Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicItemsWmtsTileMatrixSetCapabilitiesXml
 */
export const GetMosaicItemsWmtsTileMatrixSetCapabilitiesXmlHttp = Layer.effect(
  GetMosaicItemsWmtsTileMatrixSetCapabilitiesXml,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicItemsWmtsTileMatrixSetCapabilitiesXml",
    operation: geocatalog.GetMosaicItemsWmtsTileMatrixSetCapabilitiesXml,
    grant: GeoCatalogRole.Reader,
  }),
);
