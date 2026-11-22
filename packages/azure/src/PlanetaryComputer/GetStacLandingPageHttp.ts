import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetStacLandingPage } from "./GetStacLandingPage.ts";

/**
 * Implementation of {@link GetStacLandingPage} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetStacLandingPage
 */
export const GetStacLandingPageHttp = Layer.effect(
  GetStacLandingPage,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetStacLandingPage",
    operation: geocatalog.GetStacLandingPage,
    grant: GeoCatalogRole.Reader,
  }),
);
