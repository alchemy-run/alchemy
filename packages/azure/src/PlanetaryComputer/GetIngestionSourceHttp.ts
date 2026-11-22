import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetIngestionSource } from "./GetIngestionSource.ts";

/**
 * Implementation of {@link GetIngestionSource} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetIngestionSource
 */
export const GetIngestionSourceHttp = Layer.effect(
  GetIngestionSource,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetIngestionSource",
    operation: geocatalog.GetIngestionSource,
    grant: GeoCatalogRole.Reader,
  }),
);
