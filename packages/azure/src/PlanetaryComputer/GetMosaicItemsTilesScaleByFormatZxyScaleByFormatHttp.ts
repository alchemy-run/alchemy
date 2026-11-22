import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicItemsTilesScaleByFormatZxyScaleByFormat } from "./GetMosaicItemsTilesScaleByFormatZxyScaleByFormat.ts";

/**
 * Implementation of {@link GetMosaicItemsTilesScaleByFormatZxyScaleByFormat}
 * over the distilled `orbital-planetary-computer` data plane. Assigns
 * **GeoCatalog Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicItemsTilesScaleByFormatZxyScaleByFormat
 */
export const GetMosaicItemsTilesScaleByFormatZxyScaleByFormatHttp = Layer.effect(
  GetMosaicItemsTilesScaleByFormatZxyScaleByFormat,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicItemsTilesScaleByFormatZxyScaleByFormat",
    operation: geocatalog.GetMosaicItemsTilesScaleByFormatZxyScaleByFormat,
    grant: GeoCatalogRole.Reader,
  }),
);
