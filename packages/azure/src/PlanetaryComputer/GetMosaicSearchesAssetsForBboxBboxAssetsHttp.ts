import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicSearchesAssetsForBboxBboxAssets } from "./GetMosaicSearchesAssetsForBboxBboxAssets.ts";

/**
 * Implementation of {@link GetMosaicSearchesAssetsForBboxBboxAssets} over the
 * distilled `orbital-planetary-computer` data plane. Assigns **GeoCatalog
 * Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicSearchesAssetsForBboxBboxAssets
 */
export const GetMosaicSearchesAssetsForBboxBboxAssetsHttp = Layer.effect(
  GetMosaicSearchesAssetsForBboxBboxAssets,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicSearchesAssetsForBboxBboxAssets",
    operation: geocatalog.GetMosaicSearchesAssetsForBboxBboxAssets,
    grant: GeoCatalogRole.Reader,
  }),
);
