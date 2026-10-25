import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { MosaicItemsFeatureGeoJsonFormatCropFormat } from "./MosaicItemsFeatureGeoJsonFormatCropFormat.ts";

/**
 * Implementation of {@link MosaicItemsFeatureGeoJsonFormatCropFormat} over the
 * distilled `orbital-planetary-computer` data plane. Assigns **GeoCatalog
 * Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.MosaicItemsFeatureGeoJsonFormatCropFormat
 */
export const MosaicItemsFeatureGeoJsonFormatCropFormatHttp = Layer.effect(
  MosaicItemsFeatureGeoJsonFormatCropFormat,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.MosaicItemsFeatureGeoJsonFormatCropFormat",
    operation: geocatalog.MosaicItemsFeatureGeoJsonFormatCropFormat,
    grant: GeoCatalogRole.Reader,
  }),
);
