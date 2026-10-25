import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicItemsTilesFormatZxyByFormat } from "./GetMosaicItemsTilesFormatZxyByFormat.ts";

/**
 * Implementation of {@link GetMosaicItemsTilesFormatZxyByFormat} over the
 * distilled `orbital-planetary-computer` data plane. Assigns **GeoCatalog
 * Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicItemsTilesFormatZxyByFormat
 */
export const GetMosaicItemsTilesFormatZxyByFormatHttp = Layer.effect(
  GetMosaicItemsTilesFormatZxyByFormat,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicItemsTilesFormatZxyByFormat",
    operation: geocatalog.GetMosaicItemsTilesFormatZxyByFormat,
    grant: GeoCatalogRole.Reader,
  }),
);
