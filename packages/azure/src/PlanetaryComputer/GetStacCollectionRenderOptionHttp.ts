import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetStacCollectionRenderOption } from "./GetStacCollectionRenderOption.ts";

/**
 * Implementation of {@link GetStacCollectionRenderOption} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetStacCollectionRenderOption
 */
export const GetStacCollectionRenderOptionHttp = Layer.effect(
  GetStacCollectionRenderOption,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetStacCollectionRenderOption",
    operation: geocatalog.GetStacCollectionRenderOption,
    grant: GeoCatalogRole.Reader,
  }),
);
