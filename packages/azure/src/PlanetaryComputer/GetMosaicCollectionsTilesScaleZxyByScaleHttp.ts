import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicCollectionsTilesScaleZxyByScale } from "./GetMosaicCollectionsTilesScaleZxyByScale.ts";

/**
 * Implementation of {@link GetMosaicCollectionsTilesScaleZxyByScale} over the
 * distilled `orbital-planetary-computer` data plane. Assigns **GeoCatalog
 * Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicCollectionsTilesScaleZxyByScale
 */
export const GetMosaicCollectionsTilesScaleZxyByScaleHttp = Layer.effect(
  GetMosaicCollectionsTilesScaleZxyByScale,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicCollectionsTilesScaleZxyByScale",
    operation: geocatalog.GetMosaicCollectionsTilesScaleZxyByScale,
    grant: GeoCatalogRole.Reader,
  }),
);
