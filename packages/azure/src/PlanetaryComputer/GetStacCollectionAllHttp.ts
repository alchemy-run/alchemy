import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetStacCollectionAll } from "./GetStacCollectionAll.ts";

/**
 * Implementation of {@link GetStacCollectionAll} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetStacCollectionAll
 */
export const GetStacCollectionAllHttp = Layer.effect(
  GetStacCollectionAll,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetStacCollectionAll",
    operation: geocatalog.GetStacCollectionAll,
    grant: GeoCatalogRole.Reader,
  }),
);
