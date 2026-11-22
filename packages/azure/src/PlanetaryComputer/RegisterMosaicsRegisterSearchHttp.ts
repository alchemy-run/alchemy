import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { RegisterMosaicsRegisterSearch } from "./RegisterMosaicsRegisterSearch.ts";

/**
 * Implementation of {@link RegisterMosaicsRegisterSearch} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.RegisterMosaicsRegisterSearch
 */
export const RegisterMosaicsRegisterSearchHttp = Layer.effect(
  RegisterMosaicsRegisterSearch,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.RegisterMosaicsRegisterSearch",
    operation: geocatalog.RegisterMosaicsRegisterSearch,
    grant: GeoCatalogRole.Reader,
  }),
);
