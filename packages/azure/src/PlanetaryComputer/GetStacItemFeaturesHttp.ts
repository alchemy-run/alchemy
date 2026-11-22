import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetStacItemFeatures } from "./GetStacItemFeatures.ts";

/**
 * Implementation of {@link GetStacItemFeatures} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetStacItemFeatures
 */
export const GetStacItemFeaturesHttp = Layer.effect(
  GetStacItemFeatures,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetStacItemFeatures",
    operation: geocatalog.GetStacItemFeatures,
    grant: GeoCatalogRole.Reader,
  }),
);
