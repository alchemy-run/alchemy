import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicItemsAssetStatisticsAll } from "./GetMosaicItemsAssetStatisticsAll.ts";

/**
 * Implementation of {@link GetMosaicItemsAssetStatisticsAll} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicItemsAssetStatisticsAll
 */
export const GetMosaicItemsAssetStatisticsAllHttp = Layer.effect(
  GetMosaicItemsAssetStatisticsAll,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicItemsAssetStatisticsAll",
    operation: geocatalog.GetMosaicItemsAssetStatisticsAll,
    grant: GeoCatalogRole.Reader,
  }),
);
