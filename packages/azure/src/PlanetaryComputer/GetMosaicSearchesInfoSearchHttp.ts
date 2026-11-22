import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicSearchesInfoSearch } from "./GetMosaicSearchesInfoSearch.ts";

/**
 * Implementation of {@link GetMosaicSearchesInfoSearch} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicSearchesInfoSearch
 */
export const GetMosaicSearchesInfoSearchHttp = Layer.effect(
  GetMosaicSearchesInfoSearch,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicSearchesInfoSearch",
    operation: geocatalog.GetMosaicSearchesInfoSearch,
    grant: GeoCatalogRole.Reader,
  }),
);
