import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicSearchesTileSetMetadata } from "./GetMosaicSearchesTileSetMetadata.ts";

/**
 * Implementation of {@link GetMosaicSearchesTileSetMetadata} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicSearchesTileSetMetadata
 */
export const GetMosaicSearchesTileSetMetadataHttp = Layer.effect(
  GetMosaicSearchesTileSetMetadata,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicSearchesTileSetMetadata",
    operation: geocatalog.GetMosaicSearchesTileSetMetadata,
    grant: GeoCatalogRole.Reader,
  }),
);
