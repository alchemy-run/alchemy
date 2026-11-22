import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicCollectionsBboxCroppedToBoundingBox } from "./GetMosaicCollectionsBboxCroppedToBoundingBox.ts";

/**
 * Implementation of {@link GetMosaicCollectionsBboxCroppedToBoundingBox} over
 * the distilled `orbital-planetary-computer` data plane. Assigns **GeoCatalog
 * Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicCollectionsBboxCroppedToBoundingBox
 */
export const GetMosaicCollectionsBboxCroppedToBoundingBoxHttp = Layer.effect(
  GetMosaicCollectionsBboxCroppedToBoundingBox,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicCollectionsBboxCroppedToBoundingBox",
    operation: geocatalog.GetMosaicCollectionsBboxCroppedToBoundingBox,
    grant: GeoCatalogRole.Reader,
  }),
);
