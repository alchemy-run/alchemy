import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { DeleteStacCollectionRenderOption } from "./DeleteStacCollectionRenderOption.ts";

/**
 * Implementation of {@link DeleteStacCollectionRenderOption} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Administrator**
 * on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.DeleteStacCollectionRenderOption
 */
export const DeleteStacCollectionRenderOptionHttp = Layer.effect(
  DeleteStacCollectionRenderOption,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.DeleteStacCollectionRenderOption",
    operation: geocatalog.DeleteStacCollectionRenderOption,
    grant: GeoCatalogRole.Administrator,
  }),
);
