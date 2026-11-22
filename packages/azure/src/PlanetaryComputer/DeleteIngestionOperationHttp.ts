import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { DeleteIngestionOperation } from "./DeleteIngestionOperation.ts";

/**
 * Implementation of {@link DeleteIngestionOperation} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Administrator**
 * on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.DeleteIngestionOperation
 */
export const DeleteIngestionOperationHttp = Layer.effect(
  DeleteIngestionOperation,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.DeleteIngestionOperation",
    operation: geocatalog.DeleteIngestionOperation,
    grant: GeoCatalogRole.Administrator,
  }),
);
