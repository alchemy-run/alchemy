import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicSearchesTileMatrixSetZxyScaleByFormat } from "./GetMosaicSearchesTileMatrixSetZxyScaleByFormat.ts";

/**
 * Implementation of {@link GetMosaicSearchesTileMatrixSetZxyScaleByFormat} over
 * the distilled `orbital-planetary-computer` data plane. Assigns **GeoCatalog
 * Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicSearchesTileMatrixSetZxyScaleByFormat
 */
export const GetMosaicSearchesTileMatrixSetZxyScaleByFormatHttp = Layer.effect(
  GetMosaicSearchesTileMatrixSetZxyScaleByFormat,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicSearchesTileMatrixSetZxyScaleByFormat",
    operation: geocatalog.GetMosaicSearchesTileMatrixSetZxyScaleByFormat,
    grant: GeoCatalogRole.Reader,
  }),
);
