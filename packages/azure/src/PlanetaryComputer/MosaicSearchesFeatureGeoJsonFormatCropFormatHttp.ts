import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { MosaicSearchesFeatureGeoJsonFormatCropFormat } from "./MosaicSearchesFeatureGeoJsonFormatCropFormat.ts";

/**
 * Implementation of {@link MosaicSearchesFeatureGeoJsonFormatCropFormat} over
 * the distilled `orbital-planetary-computer` data plane. Assigns **GeoCatalog
 * Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.MosaicSearchesFeatureGeoJsonFormatCropFormat
 */
export const MosaicSearchesFeatureGeoJsonFormatCropFormatHttp = Layer.effect(
  MosaicSearchesFeatureGeoJsonFormatCropFormat,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.MosaicSearchesFeatureGeoJsonFormatCropFormat",
    operation: geocatalog.MosaicSearchesFeatureGeoJsonFormatCropFormat,
    grant: GeoCatalogRole.Reader,
  }),
);
