import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { ReplaceStacItem } from "./ReplaceStacItem.ts";

/**
 * Implementation of {@link ReplaceStacItem} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Administrator**
 * on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.ReplaceStacItem
 */
export const ReplaceStacItemHttp = Layer.effect(
  ReplaceStacItem,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.ReplaceStacItem",
    operation: geocatalog.ReplaceStacItem,
    grant: GeoCatalogRole.Administrator,
  }),
);
