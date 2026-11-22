import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicCollectionsTileMatrixSetsTileJson } from "./GetMosaicCollectionsTileMatrixSetsTileJson.ts";

/**
 * Implementation of {@link GetMosaicCollectionsTileMatrixSetsTileJson} over the
 * distilled `orbital-planetary-computer` data plane. Assigns **GeoCatalog
 * Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicCollectionsTileMatrixSetsTileJson
 */
export const GetMosaicCollectionsTileMatrixSetsTileJsonHttp = Layer.effect(
  GetMosaicCollectionsTileMatrixSetsTileJson,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicCollectionsTileMatrixSetsTileJson",
    operation: geocatalog.GetMosaicCollectionsTileMatrixSetsTileJson,
    grant: GeoCatalogRole.Reader,
  }),
);
