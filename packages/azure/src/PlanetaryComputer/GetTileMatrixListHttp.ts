import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetTileMatrixList } from "./GetTileMatrixList.ts";

/**
 * Implementation of {@link GetTileMatrixList} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetTileMatrixList
 */
export const GetTileMatrixListHttp = Layer.effect(
  GetTileMatrixList,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetTileMatrixList",
    operation: geocatalog.GetTileMatrixList,
    grant: GeoCatalogRole.Reader,
  }),
);
