import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { ListIngestions } from "./ListIngestions.ts";

/**
 * Implementation of {@link ListIngestions} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.ListIngestions
 */
export const ListIngestionsHttp = Layer.effect(
  ListIngestions,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.ListIngestions",
    operation: geocatalog.ListIngestions,
    grant: GeoCatalogRole.Reader,
  }),
);
