import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicItemsTileMatrixSetsFormatZxyByFormat } from "./GetMosaicItemsTileMatrixSetsFormatZxyByFormat.ts";

/**
 * Implementation of {@link GetMosaicItemsTileMatrixSetsFormatZxyByFormat} over
 * the distilled `orbital-planetary-computer` data plane. Assigns **GeoCatalog
 * Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicItemsTileMatrixSetsFormatZxyByFormat
 */
export const GetMosaicItemsTileMatrixSetsFormatZxyByFormatHttp = Layer.effect(
  GetMosaicItemsTileMatrixSetsFormatZxyByFormat,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicItemsTileMatrixSetsFormatZxyByFormat",
    operation: geocatalog.GetMosaicItemsTileMatrixSetsFormatZxyByFormat,
    grant: GeoCatalogRole.Reader,
  }),
);
