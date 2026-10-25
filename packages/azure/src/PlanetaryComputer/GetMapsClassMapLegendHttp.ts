import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMapsClassMapLegend } from "./GetMapsClassMapLegend.ts";

/**
 * Implementation of {@link GetMapsClassMapLegend} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMapsClassMapLegend
 */
export const GetMapsClassMapLegendHttp = Layer.effect(
  GetMapsClassMapLegend,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMapsClassMapLegend",
    operation: geocatalog.GetMapsClassMapLegend,
    grant: GeoCatalogRole.Reader,
  }),
);
