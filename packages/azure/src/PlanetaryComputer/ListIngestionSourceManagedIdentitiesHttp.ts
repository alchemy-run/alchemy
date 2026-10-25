import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { ListIngestionSourceManagedIdentities } from "./ListIngestionSourceManagedIdentities.ts";

/**
 * Implementation of {@link ListIngestionSourceManagedIdentities} over the
 * distilled `orbital-planetary-computer` data plane. Assigns **GeoCatalog
 * Reader** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.ListIngestionSourceManagedIdentities
 */
export const ListIngestionSourceManagedIdentitiesHttp = Layer.effect(
  ListIngestionSourceManagedIdentities,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.ListIngestionSourceManagedIdentities",
    operation: geocatalog.ListIngestionSourceManagedIdentities,
    grant: GeoCatalogRole.Reader,
  }),
);
