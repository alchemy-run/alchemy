import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetTileMatrixDefinition } from "./GetTileMatrixDefinition.ts";

/**
 * Implementation of {@link GetTileMatrixDefinition} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetTileMatrixDefinition
 */
export const GetTileMatrixDefinitionHttp = Layer.effect(
  GetTileMatrixDefinition,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetTileMatrixDefinition",
    operation: geocatalog.GetTileMatrixDefinition,
    grant: GeoCatalogRole.Reader,
  }),
);
