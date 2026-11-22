import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { ListIngestionOperations } from "./ListIngestionOperations.ts";

/**
 * Implementation of {@link ListIngestionOperations} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.ListIngestionOperations
 */
export const ListIngestionOperationsHttp = Layer.effect(
  ListIngestionOperations,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.ListIngestionOperations",
    operation: geocatalog.ListIngestionOperations,
    grant: GeoCatalogRole.Reader,
  }),
);
