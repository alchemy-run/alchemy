import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicItemsTileMatrixSetsPlainZxy } from "./GetMosaicItemsTileMatrixSetsPlainZxy.ts";

/**
 * Implementation of {@link GetMosaicItemsTileMatrixSetsPlainZxy} over the
 * distilled `orbital-planetary-computer` data plane. Assigns **GeoCatalog
 * Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicItemsTileMatrixSetsPlainZxy
 */
export const GetMosaicItemsTileMatrixSetsPlainZxyHttp = Layer.effect(
  GetMosaicItemsTileMatrixSetsPlainZxy,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicItemsTileMatrixSetsPlainZxy",
    operation: geocatalog.GetMosaicItemsTileMatrixSetsPlainZxy,
    grant: GeoCatalogRole.Reader,
  }),
);
