import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicItemsTileSetList } from "./GetMosaicItemsTileSetList.ts";

/**
 * Implementation of {@link GetMosaicItemsTileSetList} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicItemsTileSetList
 */
export const GetMosaicItemsTileSetListHttp = Layer.effect(
  GetMosaicItemsTileSetList,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicItemsTileSetList",
    operation: geocatalog.GetMosaicItemsTileSetList,
    grant: GeoCatalogRole.Reader,
  }),
);
