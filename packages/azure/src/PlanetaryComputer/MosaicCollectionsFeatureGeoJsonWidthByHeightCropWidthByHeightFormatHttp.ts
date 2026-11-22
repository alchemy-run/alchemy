import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { MosaicCollectionsFeatureGeoJsonWidthByHeightCropWidthByHeightFormat } from "./MosaicCollectionsFeatureGeoJsonWidthByHeightCropWidthByHeightFormat.ts";

/**
 * Implementation of {@link
 * MosaicCollectionsFeatureGeoJsonWidthByHeightCropWidthByHeightFormat} over the
 * distilled `orbital-planetary-computer` data plane. Assigns **GeoCatalog
 * Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.MosaicCollectionsFeatureGeoJsonWidthByHeightCropWidthByHeightFormat
 */
export const MosaicCollectionsFeatureGeoJsonWidthByHeightCropWidthByHeightFormatHttp = Layer.effect(
  MosaicCollectionsFeatureGeoJsonWidthByHeightCropWidthByHeightFormat,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.MosaicCollectionsFeatureGeoJsonWidthByHeightCropWidthByHeightFormat",
    operation: geocatalog.MosaicCollectionsFeatureGeoJsonWidthByHeightCropWidthByHeightFormat,
    grant: GeoCatalogRole.Reader,
  }),
);
