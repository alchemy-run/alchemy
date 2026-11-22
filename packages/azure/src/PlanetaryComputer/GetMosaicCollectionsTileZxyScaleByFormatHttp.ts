import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicCollectionsTileZxyScaleByFormat } from "./GetMosaicCollectionsTileZxyScaleByFormat.ts";

/**
 * Implementation of {@link GetMosaicCollectionsTileZxyScaleByFormat} over the
 * distilled `orbital-planetary-computer` data plane. Assigns **GeoCatalog
 * Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicCollectionsTileZxyScaleByFormat
 */
export const GetMosaicCollectionsTileZxyScaleByFormatHttp = Layer.effect(
  GetMosaicCollectionsTileZxyScaleByFormat,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicCollectionsTileZxyScaleByFormat",
    operation: geocatalog.GetMosaicCollectionsTileZxyScaleByFormat,
    grant: GeoCatalogRole.Reader,
  }),
);
