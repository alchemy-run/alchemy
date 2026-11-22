import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicItemsTileMatrixSetsScaleZxyByScale } from "./GetMosaicItemsTileMatrixSetsScaleZxyByScale.ts";

/**
 * Implementation of {@link GetMosaicItemsTileMatrixSetsScaleZxyByScale} over
 * the distilled `orbital-planetary-computer` data plane. Assigns **GeoCatalog
 * Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicItemsTileMatrixSetsScaleZxyByScale
 */
export const GetMosaicItemsTileMatrixSetsScaleZxyByScaleHttp = Layer.effect(
  GetMosaicItemsTileMatrixSetsScaleZxyByScale,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicItemsTileMatrixSetsScaleZxyByScale",
    operation: geocatalog.GetMosaicItemsTileMatrixSetsScaleZxyByScale,
    grant: GeoCatalogRole.Reader,
  }),
);
