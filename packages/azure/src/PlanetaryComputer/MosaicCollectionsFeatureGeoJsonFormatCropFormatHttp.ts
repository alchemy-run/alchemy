import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { MosaicCollectionsFeatureGeoJsonFormatCropFormat } from "./MosaicCollectionsFeatureGeoJsonFormatCropFormat.ts";

/**
 * Implementation of {@link MosaicCollectionsFeatureGeoJsonFormatCropFormat}
 * over the distilled `orbital-planetary-computer` data plane. Assigns
 * **GeoCatalog Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.MosaicCollectionsFeatureGeoJsonFormatCropFormat
 */
export const MosaicCollectionsFeatureGeoJsonFormatCropFormatHttp = Layer.effect(
  MosaicCollectionsFeatureGeoJsonFormatCropFormat,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.MosaicCollectionsFeatureGeoJsonFormatCropFormat",
    operation: geocatalog.MosaicCollectionsFeatureGeoJsonFormatCropFormat,
    grant: GeoCatalogRole.Reader,
  }),
);
