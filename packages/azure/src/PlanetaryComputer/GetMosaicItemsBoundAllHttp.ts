import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetMosaicItemsBoundAll } from "./GetMosaicItemsBoundAll.ts";

/**
 * Implementation of {@link GetMosaicItemsBoundAll} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetMosaicItemsBoundAll
 */
export const GetMosaicItemsBoundAllHttp = Layer.effect(
  GetMosaicItemsBoundAll,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetMosaicItemsBoundAll",
    operation: geocatalog.GetMosaicItemsBoundAll,
    grant: GeoCatalogRole.Reader,
  }),
);
