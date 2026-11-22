import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { ReplaceStacCollectionRenderOption } from "./ReplaceStacCollectionRenderOption.ts";

/**
 * Implementation of {@link ReplaceStacCollectionRenderOption} over the
 * distilled `orbital-planetary-computer` data plane. Assigns **GeoCatalog
 * Administrator** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.ReplaceStacCollectionRenderOption
 */
export const ReplaceStacCollectionRenderOptionHttp = Layer.effect(
  ReplaceStacCollectionRenderOption,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.ReplaceStacCollectionRenderOption",
    operation: geocatalog.ReplaceStacCollectionRenderOption,
    grant: GeoCatalogRole.Administrator,
  }),
);
