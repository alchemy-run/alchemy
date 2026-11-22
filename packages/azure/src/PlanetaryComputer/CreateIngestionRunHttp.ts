import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { CreateIngestionRun } from "./CreateIngestionRun.ts";

/**
 * Implementation of {@link CreateIngestionRun} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Administrator**
 * on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.CreateIngestionRun
 */
export const CreateIngestionRunHttp = Layer.effect(
  CreateIngestionRun,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.CreateIngestionRun",
    operation: geocatalog.CreateIngestionRun,
    grant: GeoCatalogRole.Administrator,
  }),
);
