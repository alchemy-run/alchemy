import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { ListIngestionRuns } from "./ListIngestionRuns.ts";

/**
 * Implementation of {@link ListIngestionRuns} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.ListIngestionRuns
 */
export const ListIngestionRunsHttp = Layer.effect(
  ListIngestionRuns,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.ListIngestionRuns",
    operation: geocatalog.ListIngestionRuns,
    grant: GeoCatalogRole.Reader,
  }),
);
