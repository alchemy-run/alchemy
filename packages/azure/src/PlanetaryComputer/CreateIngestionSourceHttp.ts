import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { CreateIngestionSource } from "./CreateIngestionSource.ts";

/**
 * Implementation of {@link CreateIngestionSource} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Administrator**
 * on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.CreateIngestionSource
 */
export const CreateIngestionSourceHttp = Layer.effect(
  CreateIngestionSource,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.CreateIngestionSource",
    operation: geocatalog.CreateIngestionSource,
    grant: GeoCatalogRole.Administrator,
  }),
);
