import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicItemsPreviewFormatFormat } from "./GetMosaicItemsPreviewFormatFormat.ts";

/**
 * Implementation of {@link GetMosaicItemsPreviewFormatFormat} over the
 * distilled `orbital-planetary-computer` data plane. Assigns **GeoCatalog
 * Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicItemsPreviewFormatFormat
 */
export const GetMosaicItemsPreviewFormatFormatHttp = Layer.effect(
  GetMosaicItemsPreviewFormatFormat,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicItemsPreviewFormatFormat",
    operation: geocatalog.GetMosaicItemsPreviewFormatFormat,
    grant: GeoCatalogRole.Reader,
  }),
);
