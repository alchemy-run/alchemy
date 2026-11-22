import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicItemsTileMatrixSetsTileJson } from "./GetMosaicItemsTileMatrixSetsTileJson.ts";

/**
 * Implementation of {@link GetMosaicItemsTileMatrixSetsTileJson} over the
 * distilled `orbital-planetary-computer` data plane. Assigns **GeoCatalog
 * Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicItemsTileMatrixSetsTileJson
 */
export const GetMosaicItemsTileMatrixSetsTileJsonHttp = Layer.effect(
  GetMosaicItemsTileMatrixSetsTileJson,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicItemsTileMatrixSetsTileJson",
    operation: geocatalog.GetMosaicItemsTileMatrixSetsTileJson,
    grant: GeoCatalogRole.Reader,
  }),
);
