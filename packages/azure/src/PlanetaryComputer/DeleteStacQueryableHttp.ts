import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { DeleteStacQueryable } from "./DeleteStacQueryable.ts";

/**
 * Implementation of {@link DeleteStacQueryable} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Administrator**
 * on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.DeleteStacQueryable
 */
export const DeleteStacQueryableHttp = Layer.effect(
  DeleteStacQueryable,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.DeleteStacQueryable",
    operation: geocatalog.DeleteStacQueryable,
    grant: GeoCatalogRole.Administrator,
  }),
);
