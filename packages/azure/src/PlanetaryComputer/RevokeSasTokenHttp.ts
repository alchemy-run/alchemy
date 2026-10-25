import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { RevokeSasToken } from "./RevokeSasToken.ts";

/**
 * Implementation of {@link RevokeSasToken} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Administrator**
 * on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.RevokeSasToken
 */
export const RevokeSasTokenHttp = Layer.effect(
  RevokeSasToken,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.RevokeSasToken",
    operation: geocatalog.RevokeSasToken,
    grant: GeoCatalogRole.Administrator,
  }),
);
