import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { ReplaceStacCollection } from "./ReplaceStacCollection.ts";

/**
 * Implementation of {@link ReplaceStacCollection} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Administrator**
 * on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.ReplaceStacCollection
 */
export const ReplaceStacCollectionHttp = Layer.effect(
  ReplaceStacCollection,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.ReplaceStacCollection",
    operation: geocatalog.ReplaceStacCollection,
    grant: GeoCatalogRole.Administrator,
  }),
);
