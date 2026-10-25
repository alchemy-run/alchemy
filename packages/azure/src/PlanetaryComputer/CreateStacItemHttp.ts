import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { CreateStacItem } from "./CreateStacItem.ts";

/**
 * Implementation of {@link CreateStacItem} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Administrator**
 * on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.CreateStacItem
 */
export const CreateStacItemHttp = Layer.effect(
  CreateStacItem,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.CreateStacItem",
    operation: geocatalog.CreateStacItem,
    grant: GeoCatalogRole.Administrator,
  }),
);
