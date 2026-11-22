import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { CreateStacCollection } from "./CreateStacCollection.ts";

/**
 * Implementation of {@link CreateStacCollection} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Administrator**
 * on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.CreateStacCollection
 */
export const CreateStacCollectionHttp = Layer.effect(
  CreateStacCollection,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.CreateStacCollection",
    operation: geocatalog.CreateStacCollection,
    grant: GeoCatalogRole.Administrator,
  }),
);
