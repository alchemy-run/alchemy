import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { UpdateIngestion } from "./UpdateIngestion.ts";

/**
 * Implementation of {@link UpdateIngestion} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Administrator**
 * on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.UpdateIngestion
 */
export const UpdateIngestionHttp = Layer.effect(
  UpdateIngestion,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.UpdateIngestion",
    operation: geocatalog.UpdateIngestion,
    grant: GeoCatalogRole.Administrator,
  }),
);
