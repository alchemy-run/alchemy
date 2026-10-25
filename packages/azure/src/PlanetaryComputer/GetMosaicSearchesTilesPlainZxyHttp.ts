import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicSearchesTilesPlainZxy } from "./GetMosaicSearchesTilesPlainZxy.ts";

/**
 * Implementation of {@link GetMosaicSearchesTilesPlainZxy} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicSearchesTilesPlainZxy
 */
export const GetMosaicSearchesTilesPlainZxyHttp = Layer.effect(
  GetMosaicSearchesTilesPlainZxy,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicSearchesTilesPlainZxy",
    operation: geocatalog.GetMosaicSearchesTilesPlainZxy,
    grant: GeoCatalogRole.Reader,
  }),
);
