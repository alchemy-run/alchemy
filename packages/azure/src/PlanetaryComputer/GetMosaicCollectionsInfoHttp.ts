import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicCollectionsInfo } from "./GetMosaicCollectionsInfo.ts";

/**
 * Implementation of {@link GetMosaicCollectionsInfo} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicCollectionsInfo
 */
export const GetMosaicCollectionsInfoHttp = Layer.effect(
  GetMosaicCollectionsInfo,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicCollectionsInfo",
    operation: geocatalog.GetMosaicCollectionsInfo,
    grant: GeoCatalogRole.Reader,
  }),
);
