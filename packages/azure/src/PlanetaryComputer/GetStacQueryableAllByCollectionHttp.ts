import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetStacQueryableAllByCollection } from "./GetStacQueryableAllByCollection.ts";

/**
 * Implementation of {@link GetStacQueryableAllByCollection} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetStacQueryableAllByCollection
 */
export const GetStacQueryableAllByCollectionHttp = Layer.effect(
  GetStacQueryableAllByCollection,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetStacQueryableAllByCollection",
    operation: geocatalog.GetStacQueryableAllByCollection,
    grant: GeoCatalogRole.Reader,
  }),
);
