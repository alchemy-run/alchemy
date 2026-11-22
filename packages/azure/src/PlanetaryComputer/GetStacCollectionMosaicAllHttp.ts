import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetStacCollectionMosaicAll } from "./GetStacCollectionMosaicAll.ts";

/**
 * Implementation of {@link GetStacCollectionMosaicAll} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetStacCollectionMosaicAll
 */
export const GetStacCollectionMosaicAllHttp = Layer.effect(
  GetStacCollectionMosaicAll,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetStacCollectionMosaicAll",
    operation: geocatalog.GetStacCollectionMosaicAll,
    grant: GeoCatalogRole.Reader,
  }),
);
