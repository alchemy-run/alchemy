import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicCollectionsAssetsForTileZxyAssets } from "./GetMosaicCollectionsAssetsForTileZxyAssets.ts";

/**
 * Implementation of {@link GetMosaicCollectionsAssetsForTileZxyAssets} over the
 * distilled `orbital-planetary-computer` data plane. Assigns **GeoCatalog
 * Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicCollectionsAssetsForTileZxyAssets
 */
export const GetMosaicCollectionsAssetsForTileZxyAssetsHttp = Layer.effect(
  GetMosaicCollectionsAssetsForTileZxyAssets,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicCollectionsAssetsForTileZxyAssets",
    operation: geocatalog.GetMosaicCollectionsAssetsForTileZxyAssets,
    grant: GeoCatalogRole.Reader,
  }),
);
