import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { MosaicCollectionsFeatureGeoJsonCrop } from "./MosaicCollectionsFeatureGeoJsonCrop.ts";

/**
 * Implementation of {@link MosaicCollectionsFeatureGeoJsonCrop} over the
 * distilled `orbital-planetary-computer` data plane. Assigns **GeoCatalog
 * Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.MosaicCollectionsFeatureGeoJsonCrop
 */
export const MosaicCollectionsFeatureGeoJsonCropHttp = Layer.effect(
  MosaicCollectionsFeatureGeoJsonCrop,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.MosaicCollectionsFeatureGeoJsonCrop",
    operation: geocatalog.MosaicCollectionsFeatureGeoJsonCrop,
    grant: GeoCatalogRole.Reader,
  }),
);
