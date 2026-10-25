import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetStacCollectionMosaic } from "./GetStacCollectionMosaic.ts";

/**
 * Implementation of {@link GetStacCollectionMosaic} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetStacCollectionMosaic
 */
export const GetStacCollectionMosaicHttp = Layer.effect(
  GetStacCollectionMosaic,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetStacCollectionMosaic",
    operation: geocatalog.GetStacCollectionMosaic,
    grant: GeoCatalogRole.Reader,
  }),
);
