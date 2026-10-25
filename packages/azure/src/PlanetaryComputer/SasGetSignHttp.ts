import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { SasGetSign } from "./SasGetSign.ts";

/**
 * Implementation of {@link SasGetSign} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.SasGetSign
 */
export const SasGetSignHttp = Layer.effect(
  SasGetSign,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.SasGetSign",
    operation: geocatalog.SasGetSign,
    grant: GeoCatalogRole.Reader,
  }),
);
