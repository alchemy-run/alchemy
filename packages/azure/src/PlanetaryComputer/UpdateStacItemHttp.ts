import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { UpdateStacItem } from "./UpdateStacItem.ts";

/**
 * Implementation of {@link UpdateStacItem} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Administrator**
 * on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.UpdateStacItem
 */
export const UpdateStacItemHttp = Layer.effect(
  UpdateStacItem,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.UpdateStacItem",
    operation: geocatalog.UpdateStacItem,
    grant: GeoCatalogRole.Administrator,
  }),
);
