import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicSearchesPointWithAssetPointAssets } from "./GetMosaicSearchesPointWithAssetPointAssets.ts";

/**
 * Implementation of {@link GetMosaicSearchesPointWithAssetPointAssets} over the
 * distilled `orbital-planetary-computer` data plane. Assigns **GeoCatalog
 * Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicSearchesPointWithAssetPointAssets
 */
export const GetMosaicSearchesPointWithAssetPointAssetsHttp = Layer.effect(
  GetMosaicSearchesPointWithAssetPointAssets,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicSearchesPointWithAssetPointAssets",
    operation: geocatalog.GetMosaicSearchesPointWithAssetPointAssets,
    grant: GeoCatalogRole.Reader,
  }),
);
