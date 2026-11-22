import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { ListIngestionSources } from "./ListIngestionSources.ts";

/**
 * Implementation of {@link ListIngestionSources} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.ListIngestionSources
 */
export const ListIngestionSourcesHttp = Layer.effect(
  ListIngestionSources,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.ListIngestionSources",
    operation: geocatalog.ListIngestionSources,
    grant: GeoCatalogRole.Reader,
  }),
);
