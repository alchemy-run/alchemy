import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicItemsStatisticsAll } from "./GetMosaicItemsStatisticsAll.ts";

/**
 * Implementation of {@link GetMosaicItemsStatisticsAll} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicItemsStatisticsAll
 */
export const GetMosaicItemsStatisticsAllHttp = Layer.effect(
  GetMosaicItemsStatisticsAll,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicItemsStatisticsAll",
    operation: geocatalog.GetMosaicItemsStatisticsAll,
    grant: GeoCatalogRole.Reader,
  }),
);
