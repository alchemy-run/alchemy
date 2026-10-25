import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicSearchesTilesFormatZxyByFormat } from "./GetMosaicSearchesTilesFormatZxyByFormat.ts";

/**
 * Implementation of {@link GetMosaicSearchesTilesFormatZxyByFormat} over the
 * distilled `orbital-planetary-computer` data plane. Assigns **GeoCatalog
 * Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicSearchesTilesFormatZxyByFormat
 */
export const GetMosaicSearchesTilesFormatZxyByFormatHttp = Layer.effect(
  GetMosaicSearchesTilesFormatZxyByFormat,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicSearchesTilesFormatZxyByFormat",
    operation: geocatalog.GetMosaicSearchesTilesFormatZxyByFormat,
    grant: GeoCatalogRole.Reader,
  }),
);
