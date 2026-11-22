import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicSearchesTileMatrixSetsScaleZxyByScale } from "./GetMosaicSearchesTileMatrixSetsScaleZxyByScale.ts";

/**
 * Implementation of {@link GetMosaicSearchesTileMatrixSetsScaleZxyByScale} over
 * the distilled `orbital-planetary-computer` data plane. Assigns **GeoCatalog
 * Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicSearchesTileMatrixSetsScaleZxyByScale
 */
export const GetMosaicSearchesTileMatrixSetsScaleZxyByScaleHttp = Layer.effect(
  GetMosaicSearchesTileMatrixSetsScaleZxyByScale,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicSearchesTileMatrixSetsScaleZxyByScale",
    operation: geocatalog.GetMosaicSearchesTileMatrixSetsScaleZxyByScale,
    grant: GeoCatalogRole.Reader,
  }),
);
