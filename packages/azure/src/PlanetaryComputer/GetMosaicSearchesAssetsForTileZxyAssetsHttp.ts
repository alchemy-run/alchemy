import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicSearchesAssetsForTileZxyAssets } from "./GetMosaicSearchesAssetsForTileZxyAssets.ts";

/**
 * Implementation of {@link GetMosaicSearchesAssetsForTileZxyAssets} over the
 * distilled `orbital-planetary-computer` data plane. Assigns **GeoCatalog
 * Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicSearchesAssetsForTileZxyAssets
 */
export const GetMosaicSearchesAssetsForTileZxyAssetsHttp = Layer.effect(
  GetMosaicSearchesAssetsForTileZxyAssets,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicSearchesAssetsForTileZxyAssets",
    operation: geocatalog.GetMosaicSearchesAssetsForTileZxyAssets,
    grant: GeoCatalogRole.Reader,
  }),
);
