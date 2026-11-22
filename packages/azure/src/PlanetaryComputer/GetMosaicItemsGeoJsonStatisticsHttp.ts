import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicItemsGeoJsonStatistics } from "./GetMosaicItemsGeoJsonStatistics.ts";

/**
 * Implementation of {@link GetMosaicItemsGeoJsonStatistics} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicItemsGeoJsonStatistics
 */
export const GetMosaicItemsGeoJsonStatisticsHttp = Layer.effect(
  GetMosaicItemsGeoJsonStatistics,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicItemsGeoJsonStatistics",
    operation: geocatalog.GetMosaicItemsGeoJsonStatistics,
    grant: GeoCatalogRole.Reader,
  }),
);
