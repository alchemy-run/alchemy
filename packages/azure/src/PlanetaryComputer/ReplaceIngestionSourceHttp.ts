import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { ReplaceIngestionSource } from "./ReplaceIngestionSource.ts";

/**
 * Implementation of {@link ReplaceIngestionSource} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Administrator**
 * on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.ReplaceIngestionSource
 */
export const ReplaceIngestionSourceHttp = Layer.effect(
  ReplaceIngestionSource,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.ReplaceIngestionSource",
    operation: geocatalog.ReplaceIngestionSource,
    grant: GeoCatalogRole.Administrator,
  }),
);
