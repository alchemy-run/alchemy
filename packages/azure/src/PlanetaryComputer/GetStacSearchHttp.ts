import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetStacSearch } from "./GetStacSearch.ts";

/**
 * Implementation of {@link GetStacSearch} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetStacSearch
 */
export const GetStacSearchHttp = Layer.effect(
  GetStacSearch,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetStacSearch",
    operation: geocatalog.GetStacSearch,
    grant: GeoCatalogRole.Reader,
  }),
);
