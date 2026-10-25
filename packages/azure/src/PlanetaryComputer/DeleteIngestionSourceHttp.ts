import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { DeleteIngestionSource } from "./DeleteIngestionSource.ts";

/**
 * Implementation of {@link DeleteIngestionSource} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Administrator**
 * on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.DeleteIngestionSource
 */
export const DeleteIngestionSourceHttp = Layer.effect(
  DeleteIngestionSource,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.DeleteIngestionSource",
    operation: geocatalog.DeleteIngestionSource,
    grant: GeoCatalogRole.Administrator,
  }),
);
