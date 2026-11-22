import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicCollectionsTileMatrixSetZxyScaleByFormat } from "./GetMosaicCollectionsTileMatrixSetZxyScaleByFormat.ts";

/**
 * Implementation of {@link GetMosaicCollectionsTileMatrixSetZxyScaleByFormat}
 * over the distilled `orbital-planetary-computer` data plane. Assigns
 * **GeoCatalog Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicCollectionsTileMatrixSetZxyScaleByFormat
 */
export const GetMosaicCollectionsTileMatrixSetZxyScaleByFormatHttp = Layer.effect(
  GetMosaicCollectionsTileMatrixSetZxyScaleByFormat,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicCollectionsTileMatrixSetZxyScaleByFormat",
    operation: geocatalog.GetMosaicCollectionsTileMatrixSetZxyScaleByFormat,
    grant: GeoCatalogRole.Reader,
  }),
);
