import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicItemsPointPoint } from "./GetMosaicItemsPointPoint.ts";

/**
 * Implementation of {@link GetMosaicItemsPointPoint} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicItemsPointPoint
 */
export const GetMosaicItemsPointPointHttp = Layer.effect(
  GetMosaicItemsPointPoint,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicItemsPointPoint",
    operation: geocatalog.GetMosaicItemsPointPoint,
    grant: GeoCatalogRole.Reader,
  }),
);
