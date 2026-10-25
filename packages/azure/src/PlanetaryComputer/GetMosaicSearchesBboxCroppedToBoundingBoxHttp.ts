import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicSearchesBboxCroppedToBoundingBox } from "./GetMosaicSearchesBboxCroppedToBoundingBox.ts";

/**
 * Implementation of {@link GetMosaicSearchesBboxCroppedToBoundingBox} over the
 * distilled `orbital-planetary-computer` data plane. Assigns **GeoCatalog
 * Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicSearchesBboxCroppedToBoundingBox
 */
export const GetMosaicSearchesBboxCroppedToBoundingBoxHttp = Layer.effect(
  GetMosaicSearchesBboxCroppedToBoundingBox,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicSearchesBboxCroppedToBoundingBox",
    operation: geocatalog.GetMosaicSearchesBboxCroppedToBoundingBox,
    grant: GeoCatalogRole.Reader,
  }),
);
