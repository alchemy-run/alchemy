import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicItemsTileSetMetadata } from "./GetMosaicItemsTileSetMetadata.ts";

/**
 * Implementation of {@link GetMosaicItemsTileSetMetadata} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicItemsTileSetMetadata
 */
export const GetMosaicItemsTileSetMetadataHttp = Layer.effect(
  GetMosaicItemsTileSetMetadata,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicItemsTileSetMetadata",
    operation: geocatalog.GetMosaicItemsTileSetMetadata,
    grant: GeoCatalogRole.Reader,
  }),
);
