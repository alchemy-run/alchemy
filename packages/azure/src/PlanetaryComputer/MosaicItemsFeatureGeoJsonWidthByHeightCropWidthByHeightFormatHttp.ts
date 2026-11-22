import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { MosaicItemsFeatureGeoJsonWidthByHeightCropWidthByHeightFormat } from "./MosaicItemsFeatureGeoJsonWidthByHeightCropWidthByHeightFormat.ts";

/**
 * Implementation of {@link
 * MosaicItemsFeatureGeoJsonWidthByHeightCropWidthByHeightFormat} over the
 * distilled `orbital-planetary-computer` data plane. Assigns **GeoCatalog
 * Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.MosaicItemsFeatureGeoJsonWidthByHeightCropWidthByHeightFormat
 */
export const MosaicItemsFeatureGeoJsonWidthByHeightCropWidthByHeightFormatHttp = Layer.effect(
  MosaicItemsFeatureGeoJsonWidthByHeightCropWidthByHeightFormat,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.MosaicItemsFeatureGeoJsonWidthByHeightCropWidthByHeightFormat",
    operation: geocatalog.MosaicItemsFeatureGeoJsonWidthByHeightCropWidthByHeightFormat,
    grant: GeoCatalogRole.Reader,
  }),
);
