import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicItemsTileJson } from "./GetMosaicItemsTileJson.ts";

/**
 * Implementation of {@link GetMosaicItemsTileJson} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicItemsTileJson
 */
export const GetMosaicItemsTileJsonHttp = Layer.effect(
  GetMosaicItemsTileJson,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicItemsTileJson",
    operation: geocatalog.GetMosaicItemsTileJson,
    grant: GeoCatalogRole.Reader,
  }),
);
