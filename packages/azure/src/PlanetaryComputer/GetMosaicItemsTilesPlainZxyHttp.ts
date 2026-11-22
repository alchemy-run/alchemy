import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicItemsTilesPlainZxy } from "./GetMosaicItemsTilesPlainZxy.ts";

/**
 * Implementation of {@link GetMosaicItemsTilesPlainZxy} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicItemsTilesPlainZxy
 */
export const GetMosaicItemsTilesPlainZxyHttp = Layer.effect(
  GetMosaicItemsTilesPlainZxy,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicItemsTilesPlainZxy",
    operation: geocatalog.GetMosaicItemsTilesPlainZxy,
    grant: GeoCatalogRole.Reader,
  }),
);
