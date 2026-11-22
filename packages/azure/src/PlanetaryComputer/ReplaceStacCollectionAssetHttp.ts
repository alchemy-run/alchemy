import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { ReplaceStacCollectionAsset } from "./ReplaceStacCollectionAsset.ts";

/**
 * Implementation of {@link ReplaceStacCollectionAsset} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Administrator**
 * on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.ReplaceStacCollectionAsset
 */
export const ReplaceStacCollectionAssetHttp = Layer.effect(
  ReplaceStacCollectionAsset,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.ReplaceStacCollectionAsset",
    operation: geocatalog.ReplaceStacCollectionAsset,
    grant: GeoCatalogRole.Administrator,
  }),
);
