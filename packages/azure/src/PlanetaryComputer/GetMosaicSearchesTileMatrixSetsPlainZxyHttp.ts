import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicSearchesTileMatrixSetsPlainZxy } from "./GetMosaicSearchesTileMatrixSetsPlainZxy.ts";

/**
 * Implementation of {@link GetMosaicSearchesTileMatrixSetsPlainZxy} over the
 * distilled `orbital-planetary-computer` data plane. Assigns **GeoCatalog
 * Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicSearchesTileMatrixSetsPlainZxy
 */
export const GetMosaicSearchesTileMatrixSetsPlainZxyHttp = Layer.effect(
  GetMosaicSearchesTileMatrixSetsPlainZxy,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicSearchesTileMatrixSetsPlainZxy",
    operation: geocatalog.GetMosaicSearchesTileMatrixSetsPlainZxy,
    grant: GeoCatalogRole.Reader,
  }),
);
