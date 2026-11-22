import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicCollectionsAssetsForTileMatrixSetZxyAssets } from "./GetMosaicCollectionsAssetsForTileMatrixSetZxyAssets.ts";

/**
 * Implementation of {@link GetMosaicCollectionsAssetsForTileMatrixSetZxyAssets}
 * over the distilled `orbital-planetary-computer` data plane. Assigns
 * **GeoCatalog Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicCollectionsAssetsForTileMatrixSetZxyAssets
 */
export const GetMosaicCollectionsAssetsForTileMatrixSetZxyAssetsHttp = Layer.effect(
  GetMosaicCollectionsAssetsForTileMatrixSetZxyAssets,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicCollectionsAssetsForTileMatrixSetZxyAssets",
    operation: geocatalog.GetMosaicCollectionsAssetsForTileMatrixSetZxyAssets,
    grant: GeoCatalogRole.Reader,
  }),
);
