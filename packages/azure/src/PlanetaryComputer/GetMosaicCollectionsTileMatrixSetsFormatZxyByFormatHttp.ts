import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicCollectionsTileMatrixSetsFormatZxyByFormat } from "./GetMosaicCollectionsTileMatrixSetsFormatZxyByFormat.ts";

/**
 * Implementation of {@link GetMosaicCollectionsTileMatrixSetsFormatZxyByFormat}
 * over the distilled `orbital-planetary-computer` data plane. Assigns
 * **GeoCatalog Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicCollectionsTileMatrixSetsFormatZxyByFormat
 */
export const GetMosaicCollectionsTileMatrixSetsFormatZxyByFormatHttp = Layer.effect(
  GetMosaicCollectionsTileMatrixSetsFormatZxyByFormat,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicCollectionsTileMatrixSetsFormatZxyByFormat",
    operation: geocatalog.GetMosaicCollectionsTileMatrixSetsFormatZxyByFormat,
    grant: GeoCatalogRole.Reader,
  }),
);
