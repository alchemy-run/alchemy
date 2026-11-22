import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicItemsWmtCapabilitiesXml } from "./GetMosaicItemsWmtCapabilitiesXml.ts";

/**
 * Implementation of {@link GetMosaicItemsWmtCapabilitiesXml} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicItemsWmtCapabilitiesXml
 */
export const GetMosaicItemsWmtCapabilitiesXmlHttp = Layer.effect(
  GetMosaicItemsWmtCapabilitiesXml,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicItemsWmtCapabilitiesXml",
    operation: geocatalog.GetMosaicItemsWmtCapabilitiesXml,
    grant: GeoCatalogRole.Reader,
  }),
);
