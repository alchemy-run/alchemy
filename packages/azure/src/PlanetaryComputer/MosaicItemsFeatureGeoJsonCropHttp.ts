import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { MosaicItemsFeatureGeoJsonCrop } from "./MosaicItemsFeatureGeoJsonCrop.ts";

/**
 * Implementation of {@link MosaicItemsFeatureGeoJsonCrop} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.MosaicItemsFeatureGeoJsonCrop
 */
export const MosaicItemsFeatureGeoJsonCropHttp = Layer.effect(
  MosaicItemsFeatureGeoJsonCrop,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.MosaicItemsFeatureGeoJsonCrop",
    operation: geocatalog.MosaicItemsFeatureGeoJsonCrop,
    grant: GeoCatalogRole.Reader,
  }),
);
