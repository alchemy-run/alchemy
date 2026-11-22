import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicSearchesWmtCapabilitiesXml } from "./GetMosaicSearchesWmtCapabilitiesXml.ts";

/**
 * Implementation of {@link GetMosaicSearchesWmtCapabilitiesXml} over the
 * distilled `orbital-planetary-computer` data plane. Assigns **GeoCatalog
 * Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicSearchesWmtCapabilitiesXml
 */
export const GetMosaicSearchesWmtCapabilitiesXmlHttp = Layer.effect(
  GetMosaicSearchesWmtCapabilitiesXml,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicSearchesWmtCapabilitiesXml",
    operation: geocatalog.GetMosaicSearchesWmtCapabilitiesXml,
    grant: GeoCatalogRole.Reader,
  }),
);
