import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { CreateStacQueryable } from "./CreateStacQueryable.ts";

/**
 * Implementation of {@link CreateStacQueryable} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Administrator**
 * on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.CreateStacQueryable
 */
export const CreateStacQueryableHttp = Layer.effect(
  CreateStacQueryable,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.CreateStacQueryable",
    operation: geocatalog.CreateStacQueryable,
    grant: GeoCatalogRole.Administrator,
  }),
);
