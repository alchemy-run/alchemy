import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicSearchesPointPoint } from "./GetMosaicSearchesPointPoint.ts";

/**
 * Implementation of {@link GetMosaicSearchesPointPoint} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicSearchesPointPoint
 */
export const GetMosaicSearchesPointPointHttp = Layer.effect(
  GetMosaicSearchesPointPoint,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicSearchesPointPoint",
    operation: geocatalog.GetMosaicSearchesPointPoint,
    grant: GeoCatalogRole.Reader,
  }),
);
