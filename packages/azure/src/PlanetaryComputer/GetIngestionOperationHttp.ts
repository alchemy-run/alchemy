import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetIngestionOperation } from "./GetIngestionOperation.ts";

/**
 * Implementation of {@link GetIngestionOperation} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetIngestionOperation
 */
export const GetIngestionOperationHttp = Layer.effect(
  GetIngestionOperation,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetIngestionOperation",
    operation: geocatalog.GetIngestionOperation,
    grant: GeoCatalogRole.Reader,
  }),
);
