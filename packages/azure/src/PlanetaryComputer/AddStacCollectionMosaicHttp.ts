import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { AddStacCollectionMosaic } from "./AddStacCollectionMosaic.ts";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";

/**
 * Implementation of {@link AddStacCollectionMosaic} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Administrator**
 * on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.AddStacCollectionMosaic
 */
export const AddStacCollectionMosaicHttp = Layer.effect(
  AddStacCollectionMosaic,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.AddStacCollectionMosaic",
    operation: geocatalog.AddStacCollectionMosaic,
    grant: GeoCatalogRole.Administrator,
  }),
);
