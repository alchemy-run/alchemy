import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicItemsTileMatrixSetsScaleByFormatZxyScaleByFormat } from "./GetMosaicItemsTileMatrixSetsScaleByFormatZxyScaleByFormat.ts";

/**
 * Implementation of {@link
 * GetMosaicItemsTileMatrixSetsScaleByFormatZxyScaleByFormat} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicItemsTileMatrixSetsScaleByFormatZxyScaleByFormat
 */
export const GetMosaicItemsTileMatrixSetsScaleByFormatZxyScaleByFormatHttp = Layer.effect(
  GetMosaicItemsTileMatrixSetsScaleByFormatZxyScaleByFormat,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicItemsTileMatrixSetsScaleByFormatZxyScaleByFormat",
    operation: geocatalog.GetMosaicItemsTileMatrixSetsScaleByFormatZxyScaleByFormat,
    grant: GeoCatalogRole.Reader,
  }),
);
