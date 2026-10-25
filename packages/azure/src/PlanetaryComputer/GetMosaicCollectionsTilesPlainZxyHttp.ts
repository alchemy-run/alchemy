import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicCollectionsTilesPlainZxy } from "./GetMosaicCollectionsTilesPlainZxy.ts";

/**
 * Implementation of {@link GetMosaicCollectionsTilesPlainZxy} over the
 * distilled `orbital-planetary-computer` data plane. Assigns **GeoCatalog
 * Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicCollectionsTilesPlainZxy
 */
export const GetMosaicCollectionsTilesPlainZxyHttp = Layer.effect(
  GetMosaicCollectionsTilesPlainZxy,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicCollectionsTilesPlainZxy",
    operation: geocatalog.GetMosaicCollectionsTilesPlainZxy,
    grant: GeoCatalogRole.Reader,
  }),
);
