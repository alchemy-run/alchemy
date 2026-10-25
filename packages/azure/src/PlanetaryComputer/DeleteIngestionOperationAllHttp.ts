import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { DeleteIngestionOperationAll } from "./DeleteIngestionOperationAll.ts";

/**
 * Implementation of {@link DeleteIngestionOperationAll} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Administrator**
 * on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.DeleteIngestionOperationAll
 */
export const DeleteIngestionOperationAllHttp = Layer.effect(
  DeleteIngestionOperationAll,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.DeleteIngestionOperationAll",
    operation: geocatalog.DeleteIngestionOperationAll,
    grant: GeoCatalogRole.Administrator,
  }),
);
