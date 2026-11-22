import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { DeleteStacCollectionAsset } from "./DeleteStacCollectionAsset.ts";

/**
 * Implementation of {@link DeleteStacCollectionAsset} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Administrator**
 * on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.DeleteStacCollectionAsset
 */
export const DeleteStacCollectionAssetHttp = Layer.effect(
  DeleteStacCollectionAsset,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.DeleteStacCollectionAsset",
    operation: geocatalog.DeleteStacCollectionAsset,
    grant: GeoCatalogRole.Administrator,
  }),
);
