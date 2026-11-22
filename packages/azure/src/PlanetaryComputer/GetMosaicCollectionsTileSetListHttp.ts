import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicCollectionsTileSetList } from "./GetMosaicCollectionsTileSetList.ts";

/**
 * Implementation of {@link GetMosaicCollectionsTileSetList} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicCollectionsTileSetList
 */
export const GetMosaicCollectionsTileSetListHttp = Layer.effect(
  GetMosaicCollectionsTileSetList,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicCollectionsTileSetList",
    operation: geocatalog.GetMosaicCollectionsTileSetList,
    grant: GeoCatalogRole.Reader,
  }),
);
