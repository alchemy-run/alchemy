import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { DeleteStacItem } from "./DeleteStacItem.ts";

/**
 * Implementation of {@link DeleteStacItem} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Administrator**
 * on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.DeleteStacItem
 */
export const DeleteStacItemHttp = Layer.effect(
  DeleteStacItem,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.DeleteStacItem",
    operation: geocatalog.DeleteStacItem,
    grant: GeoCatalogRole.Administrator,
  }),
);
