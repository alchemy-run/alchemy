import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicCollectionsTileJson } from "./GetMosaicCollectionsTileJson.ts";

/**
 * Implementation of {@link GetMosaicCollectionsTileJson} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicCollectionsTileJson
 */
export const GetMosaicCollectionsTileJsonHttp = Layer.effect(
  GetMosaicCollectionsTileJson,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicCollectionsTileJson",
    operation: geocatalog.GetMosaicCollectionsTileJson,
    grant: GeoCatalogRole.Reader,
  }),
);
