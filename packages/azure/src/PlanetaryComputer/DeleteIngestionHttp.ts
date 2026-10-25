import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { DeleteIngestion } from "./DeleteIngestion.ts";

/**
 * Implementation of {@link DeleteIngestion} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Administrator**
 * on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.DeleteIngestion
 */
export const DeleteIngestionHttp = Layer.effect(
  DeleteIngestion,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.DeleteIngestion",
    operation: geocatalog.DeleteIngestion,
    grant: GeoCatalogRole.Administrator,
  }),
);
