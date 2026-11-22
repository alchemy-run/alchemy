import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { CreateStacCollectionRenderOption } from "./CreateStacCollectionRenderOption.ts";

/**
 * Implementation of {@link CreateStacCollectionRenderOption} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Administrator**
 * on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.CreateStacCollectionRenderOption
 */
export const CreateStacCollectionRenderOptionHttp = Layer.effect(
  CreateStacCollectionRenderOption,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.CreateStacCollectionRenderOption",
    operation: geocatalog.CreateStacCollectionRenderOption,
    grant: GeoCatalogRole.Administrator,
  }),
);
