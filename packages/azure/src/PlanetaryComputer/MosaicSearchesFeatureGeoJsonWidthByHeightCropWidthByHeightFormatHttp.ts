import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { MosaicSearchesFeatureGeoJsonWidthByHeightCropWidthByHeightFormat } from "./MosaicSearchesFeatureGeoJsonWidthByHeightCropWidthByHeightFormat.ts";

/**
 * Implementation of {@link
 * MosaicSearchesFeatureGeoJsonWidthByHeightCropWidthByHeightFormat} over the
 * distilled `orbital-planetary-computer` data plane. Assigns **GeoCatalog
 * Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.MosaicSearchesFeatureGeoJsonWidthByHeightCropWidthByHeightFormat
 */
export const MosaicSearchesFeatureGeoJsonWidthByHeightCropWidthByHeightFormatHttp = Layer.effect(
  MosaicSearchesFeatureGeoJsonWidthByHeightCropWidthByHeightFormat,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.MosaicSearchesFeatureGeoJsonWidthByHeightCropWidthByHeightFormat",
    operation: geocatalog.MosaicSearchesFeatureGeoJsonWidthByHeightCropWidthByHeightFormat,
    grant: GeoCatalogRole.Reader,
  }),
);
