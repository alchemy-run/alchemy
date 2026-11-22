import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicItemsPreview } from "./GetMosaicItemsPreview.ts";

/**
 * Implementation of {@link GetMosaicItemsPreview} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicItemsPreview
 */
export const GetMosaicItemsPreviewHttp = Layer.effect(
  GetMosaicItemsPreview,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicItemsPreview",
    operation: geocatalog.GetMosaicItemsPreview,
    grant: GeoCatalogRole.Reader,
  }),
);
