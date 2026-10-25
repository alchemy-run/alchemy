import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicCollectionsTilesFormatZxyByFormat } from "./GetMosaicCollectionsTilesFormatZxyByFormat.ts";

/**
 * Implementation of {@link GetMosaicCollectionsTilesFormatZxyByFormat} over the
 * distilled `orbital-planetary-computer` data plane. Assigns **GeoCatalog
 * Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicCollectionsTilesFormatZxyByFormat
 */
export const GetMosaicCollectionsTilesFormatZxyByFormatHttp = Layer.effect(
  GetMosaicCollectionsTilesFormatZxyByFormat,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicCollectionsTilesFormatZxyByFormat",
    operation: geocatalog.GetMosaicCollectionsTilesFormatZxyByFormat,
    grant: GeoCatalogRole.Reader,
  }),
);
