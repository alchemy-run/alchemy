import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicSearchesTileZxyScaleByFormat } from "./GetMosaicSearchesTileZxyScaleByFormat.ts";

/**
 * Implementation of {@link GetMosaicSearchesTileZxyScaleByFormat} over the
 * distilled `orbital-planetary-computer` data plane. Assigns **GeoCatalog
 * Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicSearchesTileZxyScaleByFormat
 */
export const GetMosaicSearchesTileZxyScaleByFormatHttp = Layer.effect(
  GetMosaicSearchesTileZxyScaleByFormat,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicSearchesTileZxyScaleByFormat",
    operation: geocatalog.GetMosaicSearchesTileZxyScaleByFormat,
    grant: GeoCatalogRole.Reader,
  }),
);
