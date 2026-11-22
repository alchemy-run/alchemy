import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicCollectionsWmtsTileMatrixSetCapabilitiesXml } from "./GetMosaicCollectionsWmtsTileMatrixSetCapabilitiesXml.ts";

/**
 * Implementation of {@link
 * GetMosaicCollectionsWmtsTileMatrixSetCapabilitiesXml} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicCollectionsWmtsTileMatrixSetCapabilitiesXml
 */
export const GetMosaicCollectionsWmtsTileMatrixSetCapabilitiesXmlHttp = Layer.effect(
  GetMosaicCollectionsWmtsTileMatrixSetCapabilitiesXml,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicCollectionsWmtsTileMatrixSetCapabilitiesXml",
    operation: geocatalog.GetMosaicCollectionsWmtsTileMatrixSetCapabilitiesXml,
    grant: GeoCatalogRole.Reader,
  }),
);
