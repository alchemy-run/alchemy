import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetStacQueryableAll } from "./GetStacQueryableAll.ts";

/**
 * Implementation of {@link GetStacQueryableAll} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetStacQueryableAll
 */
export const GetStacQueryableAllHttp = Layer.effect(
  GetStacQueryableAll,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetStacQueryableAll",
    operation: geocatalog.GetStacQueryableAll,
    grant: GeoCatalogRole.Reader,
  }),
);
