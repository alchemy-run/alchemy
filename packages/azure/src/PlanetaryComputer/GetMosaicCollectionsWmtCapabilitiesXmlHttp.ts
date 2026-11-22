import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicCollectionsWmtCapabilitiesXml } from "./GetMosaicCollectionsWmtCapabilitiesXml.ts";

/**
 * Implementation of {@link GetMosaicCollectionsWmtCapabilitiesXml} over the
 * distilled `orbital-planetary-computer` data plane. Assigns **GeoCatalog
 * Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicCollectionsWmtCapabilitiesXml
 */
export const GetMosaicCollectionsWmtCapabilitiesXmlHttp = Layer.effect(
  GetMosaicCollectionsWmtCapabilitiesXml,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicCollectionsWmtCapabilitiesXml",
    operation: geocatalog.GetMosaicCollectionsWmtCapabilitiesXml,
    grant: GeoCatalogRole.Reader,
  }),
);
