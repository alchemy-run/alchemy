import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { DeleteStacCollection } from "./DeleteStacCollection.ts";

/**
 * Implementation of {@link DeleteStacCollection} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Administrator**
 * on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.DeleteStacCollection
 */
export const DeleteStacCollectionHttp = Layer.effect(
  DeleteStacCollection,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.DeleteStacCollection",
    operation: geocatalog.DeleteStacCollection,
    grant: GeoCatalogRole.Administrator,
  }),
);
