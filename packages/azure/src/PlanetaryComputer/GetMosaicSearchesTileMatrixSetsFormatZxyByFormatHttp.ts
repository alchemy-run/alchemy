import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicSearchesTileMatrixSetsFormatZxyByFormat } from "./GetMosaicSearchesTileMatrixSetsFormatZxyByFormat.ts";

/**
 * Implementation of {@link GetMosaicSearchesTileMatrixSetsFormatZxyByFormat}
 * over the distilled `orbital-planetary-computer` data plane. Assigns
 * **GeoCatalog Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicSearchesTileMatrixSetsFormatZxyByFormat
 */
export const GetMosaicSearchesTileMatrixSetsFormatZxyByFormatHttp = Layer.effect(
  GetMosaicSearchesTileMatrixSetsFormatZxyByFormat,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicSearchesTileMatrixSetsFormatZxyByFormat",
    operation: geocatalog.GetMosaicSearchesTileMatrixSetsFormatZxyByFormat,
    grant: GeoCatalogRole.Reader,
  }),
);
