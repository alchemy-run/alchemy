import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicItemsTilesScaleZxyByScale } from "./GetMosaicItemsTilesScaleZxyByScale.ts";

/**
 * Implementation of {@link GetMosaicItemsTilesScaleZxyByScale} over the
 * distilled `orbital-planetary-computer` data plane. Assigns **GeoCatalog
 * Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicItemsTilesScaleZxyByScale
 */
export const GetMosaicItemsTilesScaleZxyByScaleHttp = Layer.effect(
  GetMosaicItemsTilesScaleZxyByScale,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicItemsTilesScaleZxyByScale",
    operation: geocatalog.GetMosaicItemsTilesScaleZxyByScale,
    grant: GeoCatalogRole.Reader,
  }),
);
