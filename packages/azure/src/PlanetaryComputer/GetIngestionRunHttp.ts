import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetIngestionRun } from "./GetIngestionRun.ts";

/**
 * Implementation of {@link GetIngestionRun} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetIngestionRun
 */
export const GetIngestionRunHttp = Layer.effect(
  GetIngestionRun,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetIngestionRun",
    operation: geocatalog.GetIngestionRun,
    grant: GeoCatalogRole.Reader,
  }),
);
