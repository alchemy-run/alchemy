import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { ReplaceStacCollectionMosaic } from "./ReplaceStacCollectionMosaic.ts";

/**
 * Implementation of {@link ReplaceStacCollectionMosaic} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Administrator**
 * on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.ReplaceStacCollectionMosaic
 */
export const ReplaceStacCollectionMosaicHttp = Layer.effect(
  ReplaceStacCollectionMosaic,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.ReplaceStacCollectionMosaic",
    operation: geocatalog.ReplaceStacCollectionMosaic,
    grant: GeoCatalogRole.Administrator,
  }),
);
