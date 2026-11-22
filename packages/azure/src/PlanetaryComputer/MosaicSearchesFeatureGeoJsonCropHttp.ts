import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { MosaicSearchesFeatureGeoJsonCrop } from "./MosaicSearchesFeatureGeoJsonCrop.ts";

/**
 * Implementation of {@link MosaicSearchesFeatureGeoJsonCrop} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.MosaicSearchesFeatureGeoJsonCrop
 */
export const MosaicSearchesFeatureGeoJsonCropHttp = Layer.effect(
  MosaicSearchesFeatureGeoJsonCrop,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.MosaicSearchesFeatureGeoJsonCrop",
    operation: geocatalog.MosaicSearchesFeatureGeoJsonCrop,
    grant: GeoCatalogRole.Reader,
  }),
);
