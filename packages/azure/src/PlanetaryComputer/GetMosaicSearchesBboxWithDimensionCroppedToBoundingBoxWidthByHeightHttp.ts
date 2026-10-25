import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicSearchesBboxWithDimensionCroppedToBoundingBoxWidthByHeight } from "./GetMosaicSearchesBboxWithDimensionCroppedToBoundingBoxWidthByHeight.ts";

/**
 * Implementation of {@link
 * GetMosaicSearchesBboxWithDimensionCroppedToBoundingBoxWidthByHeight} over the
 * distilled `orbital-planetary-computer` data plane. Assigns **GeoCatalog
 * Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicSearchesBboxWithDimensionCroppedToBoundingBoxWidthByHeight
 */
export const GetMosaicSearchesBboxWithDimensionCroppedToBoundingBoxWidthByHeightHttp = Layer.effect(
  GetMosaicSearchesBboxWithDimensionCroppedToBoundingBoxWidthByHeight,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicSearchesBboxWithDimensionCroppedToBoundingBoxWidthByHeight",
    operation: geocatalog.GetMosaicSearchesBboxWithDimensionCroppedToBoundingBoxWidthByHeight,
    grant: GeoCatalogRole.Reader,
  }),
);
