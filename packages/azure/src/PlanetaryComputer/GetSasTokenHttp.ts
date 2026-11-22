import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetSasToken } from "./GetSasToken.ts";

/**
 * Implementation of {@link GetSasToken} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetSasToken
 */
export const GetSasTokenHttp = Layer.effect(
  GetSasToken,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetSasToken",
    operation: geocatalog.GetSasToken,
    grant: GeoCatalogRole.Reader,
  }),
);
