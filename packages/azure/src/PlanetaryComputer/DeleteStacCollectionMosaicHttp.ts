import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { DeleteStacCollectionMosaic } from "./DeleteStacCollectionMosaic.ts";

/**
 * Implementation of {@link DeleteStacCollectionMosaic} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Administrator**
 * on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.DeleteStacCollectionMosaic
 */
export const DeleteStacCollectionMosaicHttp = Layer.effect(
  DeleteStacCollectionMosaic,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.DeleteStacCollectionMosaic",
    operation: geocatalog.DeleteStacCollectionMosaic,
    grant: GeoCatalogRole.Administrator,
  }),
);
