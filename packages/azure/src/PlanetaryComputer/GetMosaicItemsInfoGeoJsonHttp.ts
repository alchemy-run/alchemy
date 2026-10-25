import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicItemsInfoGeoJson } from "./GetMosaicItemsInfoGeoJson.ts";

/**
 * Implementation of {@link GetMosaicItemsInfoGeoJson} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicItemsInfoGeoJson
 */
export const GetMosaicItemsInfoGeoJsonHttp = Layer.effect(
  GetMosaicItemsInfoGeoJson,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicItemsInfoGeoJson",
    operation: geocatalog.GetMosaicItemsInfoGeoJson,
    grant: GeoCatalogRole.Reader,
  }),
);
