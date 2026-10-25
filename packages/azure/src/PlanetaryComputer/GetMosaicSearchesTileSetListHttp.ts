import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicSearchesTileSetList } from "./GetMosaicSearchesTileSetList.ts";

/**
 * Implementation of {@link GetMosaicSearchesTileSetList} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicSearchesTileSetList
 */
export const GetMosaicSearchesTileSetListHttp = Layer.effect(
  GetMosaicSearchesTileSetList,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicSearchesTileSetList",
    operation: geocatalog.GetMosaicSearchesTileSetList,
    grant: GeoCatalogRole.Reader,
  }),
);
