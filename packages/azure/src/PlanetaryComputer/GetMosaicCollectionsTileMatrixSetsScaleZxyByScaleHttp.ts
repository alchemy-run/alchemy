import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicCollectionsTileMatrixSetsScaleZxyByScale } from "./GetMosaicCollectionsTileMatrixSetsScaleZxyByScale.ts";

/**
 * Implementation of {@link GetMosaicCollectionsTileMatrixSetsScaleZxyByScale}
 * over the distilled `orbital-planetary-computer` data plane. Assigns
 * **GeoCatalog Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicCollectionsTileMatrixSetsScaleZxyByScale
 */
export const GetMosaicCollectionsTileMatrixSetsScaleZxyByScaleHttp = Layer.effect(
  GetMosaicCollectionsTileMatrixSetsScaleZxyByScale,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicCollectionsTileMatrixSetsScaleZxyByScale",
    operation: geocatalog.GetMosaicCollectionsTileMatrixSetsScaleZxyByScale,
    grant: GeoCatalogRole.Reader,
  }),
);
