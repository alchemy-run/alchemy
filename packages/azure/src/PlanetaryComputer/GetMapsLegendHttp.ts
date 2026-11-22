import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMapsLegend } from "./GetMapsLegend.ts";

/**
 * Implementation of {@link GetMapsLegend} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMapsLegend
 */
export const GetMapsLegendHttp = Layer.effect(
  GetMapsLegend,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMapsLegend",
    operation: geocatalog.GetMapsLegend,
    grant: GeoCatalogRole.Reader,
  }),
);
