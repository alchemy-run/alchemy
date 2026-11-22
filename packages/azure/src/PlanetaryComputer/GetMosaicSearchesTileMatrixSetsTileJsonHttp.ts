import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicSearchesTileMatrixSetsTileJson } from "./GetMosaicSearchesTileMatrixSetsTileJson.ts";

/**
 * Implementation of {@link GetMosaicSearchesTileMatrixSetsTileJson} over the
 * distilled `orbital-planetary-computer` data plane. Assigns **GeoCatalog
 * Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicSearchesTileMatrixSetsTileJson
 */
export const GetMosaicSearchesTileMatrixSetsTileJsonHttp = Layer.effect(
  GetMosaicSearchesTileMatrixSetsTileJson,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicSearchesTileMatrixSetsTileJson",
    operation: geocatalog.GetMosaicSearchesTileMatrixSetsTileJson,
    grant: GeoCatalogRole.Reader,
  }),
);
