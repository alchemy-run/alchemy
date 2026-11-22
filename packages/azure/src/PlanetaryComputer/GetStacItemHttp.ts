import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetStacItem } from "./GetStacItem.ts";

/**
 * Implementation of {@link GetStacItem} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetStacItem
 */
export const GetStacItemHttp = Layer.effect(
  GetStacItem,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetStacItem",
    operation: geocatalog.GetStacItem,
    grant: GeoCatalogRole.Reader,
  }),
);
