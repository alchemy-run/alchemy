import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicSearchesAssetsForTileMatrixSetZxyAssets } from "./GetMosaicSearchesAssetsForTileMatrixSetZxyAssets.ts";

/**
 * Implementation of {@link GetMosaicSearchesAssetsForTileMatrixSetZxyAssets}
 * over the distilled `orbital-planetary-computer` data plane. Assigns
 * **GeoCatalog Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicSearchesAssetsForTileMatrixSetZxyAssets
 */
export const GetMosaicSearchesAssetsForTileMatrixSetZxyAssetsHttp = Layer.effect(
  GetMosaicSearchesAssetsForTileMatrixSetZxyAssets,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicSearchesAssetsForTileMatrixSetZxyAssets",
    operation: geocatalog.GetMosaicSearchesAssetsForTileMatrixSetZxyAssets,
    grant: GeoCatalogRole.Reader,
  }),
);
