import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicCollectionsTileMatrixSetsPlainZxy } from "./GetMosaicCollectionsTileMatrixSetsPlainZxy.ts";

/**
 * Implementation of {@link GetMosaicCollectionsTileMatrixSetsPlainZxy} over the
 * distilled `orbital-planetary-computer` data plane. Assigns **GeoCatalog
 * Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicCollectionsTileMatrixSetsPlainZxy
 */
export const GetMosaicCollectionsTileMatrixSetsPlainZxyHttp = Layer.effect(
  GetMosaicCollectionsTileMatrixSetsPlainZxy,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicCollectionsTileMatrixSetsPlainZxy",
    operation: geocatalog.GetMosaicCollectionsTileMatrixSetsPlainZxy,
    grant: GeoCatalogRole.Reader,
  }),
);
