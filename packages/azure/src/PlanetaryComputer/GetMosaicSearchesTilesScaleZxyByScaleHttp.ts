import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicSearchesTilesScaleZxyByScale } from "./GetMosaicSearchesTilesScaleZxyByScale.ts";

/**
 * Implementation of {@link GetMosaicSearchesTilesScaleZxyByScale} over the
 * distilled `orbital-planetary-computer` data plane. Assigns **GeoCatalog
 * Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicSearchesTilesScaleZxyByScale
 */
export const GetMosaicSearchesTilesScaleZxyByScaleHttp = Layer.effect(
  GetMosaicSearchesTilesScaleZxyByScale,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicSearchesTilesScaleZxyByScale",
    operation: geocatalog.GetMosaicSearchesTilesScaleZxyByScale,
    grant: GeoCatalogRole.Reader,
  }),
);
