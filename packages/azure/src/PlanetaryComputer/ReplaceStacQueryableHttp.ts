import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { ReplaceStacQueryable } from "./ReplaceStacQueryable.ts";

/**
 * Implementation of {@link ReplaceStacQueryable} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Administrator**
 * on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.ReplaceStacQueryable
 */
export const ReplaceStacQueryableHttp = Layer.effect(
  ReplaceStacQueryable,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.ReplaceStacQueryable",
    operation: geocatalog.ReplaceStacQueryable,
    grant: GeoCatalogRole.Administrator,
  }),
);
