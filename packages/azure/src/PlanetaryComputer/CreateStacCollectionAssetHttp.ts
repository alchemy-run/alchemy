import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { CreateStacCollectionAsset } from "./CreateStacCollectionAsset.ts";

/**
 * Implementation of {@link CreateStacCollectionAsset} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Administrator**
 * on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.CreateStacCollectionAsset
 */
export const CreateStacCollectionAssetHttp = Layer.effect(
  CreateStacCollectionAsset,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.CreateStacCollectionAsset",
    operation: geocatalog.CreateStacCollectionAsset,
    grant: GeoCatalogRole.Administrator,
  }),
);
