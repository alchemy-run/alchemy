import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicCollectionsAssetsForBboxBboxAssets } from "./GetMosaicCollectionsAssetsForBboxBboxAssets.ts";

/**
 * Implementation of {@link GetMosaicCollectionsAssetsForBboxBboxAssets} over
 * the distilled `orbital-planetary-computer` data plane. Assigns **GeoCatalog
 * Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicCollectionsAssetsForBboxBboxAssets
 */
export const GetMosaicCollectionsAssetsForBboxBboxAssetsHttp = Layer.effect(
  GetMosaicCollectionsAssetsForBboxBboxAssets,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicCollectionsAssetsForBboxBboxAssets",
    operation: geocatalog.GetMosaicCollectionsAssetsForBboxBboxAssets,
    grant: GeoCatalogRole.Reader,
  }),
);
