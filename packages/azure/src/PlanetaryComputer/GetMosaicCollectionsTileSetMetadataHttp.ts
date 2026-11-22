import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicCollectionsTileSetMetadata } from "./GetMosaicCollectionsTileSetMetadata.ts";

/**
 * Implementation of {@link GetMosaicCollectionsTileSetMetadata} over the
 * distilled `orbital-planetary-computer` data plane. Assigns **GeoCatalog
 * Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicCollectionsTileSetMetadata
 */
export const GetMosaicCollectionsTileSetMetadataHttp = Layer.effect(
  GetMosaicCollectionsTileSetMetadata,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicCollectionsTileSetMetadata",
    operation: geocatalog.GetMosaicCollectionsTileSetMetadata,
    grant: GeoCatalogRole.Reader,
  }),
);
