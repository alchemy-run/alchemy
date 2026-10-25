import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetStacCollection } from "./GetStacCollection.ts";

/**
 * Implementation of {@link GetStacCollection} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetStacCollection
 */
export const GetStacCollectionHttp = Layer.effect(
  GetStacCollection,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetStacCollection",
    operation: geocatalog.GetStacCollection,
    grant: GeoCatalogRole.Reader,
  }),
);
