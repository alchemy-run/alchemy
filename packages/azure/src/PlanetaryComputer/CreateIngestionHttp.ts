import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { CreateIngestion } from "./CreateIngestion.ts";

/**
 * Implementation of {@link CreateIngestion} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Administrator**
 * on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.CreateIngestion
 */
export const CreateIngestionHttp = Layer.effect(
  CreateIngestion,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.CreateIngestion",
    operation: geocatalog.CreateIngestion,
    grant: GeoCatalogRole.Administrator,
  }),
);
