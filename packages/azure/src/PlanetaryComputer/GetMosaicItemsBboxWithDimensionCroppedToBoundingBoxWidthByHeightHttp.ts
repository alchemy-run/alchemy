import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicItemsBboxWithDimensionCroppedToBoundingBoxWidthByHeight } from "./GetMosaicItemsBboxWithDimensionCroppedToBoundingBoxWidthByHeight.ts";

/**
 * Implementation of {@link
 * GetMosaicItemsBboxWithDimensionCroppedToBoundingBoxWidthByHeight} over the
 * distilled `orbital-planetary-computer` data plane. Assigns **GeoCatalog
 * Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicItemsBboxWithDimensionCroppedToBoundingBoxWidthByHeight
 */
export const GetMosaicItemsBboxWithDimensionCroppedToBoundingBoxWidthByHeightHttp = Layer.effect(
  GetMosaicItemsBboxWithDimensionCroppedToBoundingBoxWidthByHeight,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicItemsBboxWithDimensionCroppedToBoundingBoxWidthByHeight",
    operation: geocatalog.GetMosaicItemsBboxWithDimensionCroppedToBoundingBoxWidthByHeight,
    grant: GeoCatalogRole.Reader,
  }),
);
