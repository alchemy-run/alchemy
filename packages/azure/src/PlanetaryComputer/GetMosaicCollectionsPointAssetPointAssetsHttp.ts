import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicCollectionsPointAssetPointAssets } from "./GetMosaicCollectionsPointAssetPointAssets.ts";

/**
 * Implementation of {@link GetMosaicCollectionsPointAssetPointAssets} over the
 * distilled `orbital-planetary-computer` data plane. Assigns **GeoCatalog
 * Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicCollectionsPointAssetPointAssets
 */
export const GetMosaicCollectionsPointAssetPointAssetsHttp = Layer.effect(
  GetMosaicCollectionsPointAssetPointAssets,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicCollectionsPointAssetPointAssets",
    operation: geocatalog.GetMosaicCollectionsPointAssetPointAssets,
    grant: GeoCatalogRole.Reader,
  }),
);
