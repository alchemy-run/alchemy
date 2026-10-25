import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetStacCollectionRenderOptionAll } from "./GetStacCollectionRenderOptionAll.ts";

/**
 * Implementation of {@link GetStacCollectionRenderOptionAll} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetStacCollectionRenderOptionAll
 */
export const GetStacCollectionRenderOptionAllHttp = Layer.effect(
  GetStacCollectionRenderOptionAll,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetStacCollectionRenderOptionAll",
    operation: geocatalog.GetStacCollectionRenderOptionAll,
    grant: GeoCatalogRole.Reader,
  }),
);
