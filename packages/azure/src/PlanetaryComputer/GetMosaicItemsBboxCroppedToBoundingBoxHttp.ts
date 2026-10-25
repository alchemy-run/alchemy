import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicItemsBboxCroppedToBoundingBox } from "./GetMosaicItemsBboxCroppedToBoundingBox.ts";

/**
 * Implementation of {@link GetMosaicItemsBboxCroppedToBoundingBox} over the
 * distilled `orbital-planetary-computer` data plane. Assigns **GeoCatalog
 * Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicItemsBboxCroppedToBoundingBox
 */
export const GetMosaicItemsBboxCroppedToBoundingBoxHttp = Layer.effect(
  GetMosaicItemsBboxCroppedToBoundingBox,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicItemsBboxCroppedToBoundingBox",
    operation: geocatalog.GetMosaicItemsBboxCroppedToBoundingBox,
    grant: GeoCatalogRole.Reader,
  }),
);
