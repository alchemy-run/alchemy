import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicSearchesTileJson } from "./GetMosaicSearchesTileJson.ts";

/**
 * Implementation of {@link GetMosaicSearchesTileJson} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicSearchesTileJson
 */
export const GetMosaicSearchesTileJsonHttp = Layer.effect(
  GetMosaicSearchesTileJson,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicSearchesTileJson",
    operation: geocatalog.GetMosaicSearchesTileJson,
    grant: GeoCatalogRole.Reader,
  }),
);
