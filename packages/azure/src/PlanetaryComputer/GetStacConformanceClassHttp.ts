import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetStacConformanceClass } from "./GetStacConformanceClass.ts";

/**
 * Implementation of {@link GetStacConformanceClass} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetStacConformanceClass
 */
export const GetStacConformanceClassHttp = Layer.effect(
  GetStacConformanceClass,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetStacConformanceClass",
    operation: geocatalog.GetStacConformanceClass,
    grant: GeoCatalogRole.Reader,
  }),
);
