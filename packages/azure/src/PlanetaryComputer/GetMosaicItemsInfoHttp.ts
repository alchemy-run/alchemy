import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicItemsInfo } from "./GetMosaicItemsInfo.ts";

/**
 * Implementation of {@link GetMosaicItemsInfo} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicItemsInfo
 */
export const GetMosaicItemsInfoHttp = Layer.effect(
  GetMosaicItemsInfo,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicItemsInfo",
    operation: geocatalog.GetMosaicItemsInfo,
    grant: GeoCatalogRole.Reader,
  }),
);
