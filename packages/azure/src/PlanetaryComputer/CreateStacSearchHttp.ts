import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { CreateStacSearch } from "./CreateStacSearch.ts";

/**
 * Implementation of {@link CreateStacSearch} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.CreateStacSearch
 */
export const CreateStacSearchHttp = Layer.effect(
  CreateStacSearch,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.CreateStacSearch",
    operation: geocatalog.CreateStacSearch,
    grant: GeoCatalogRole.Reader,
  }),
);
