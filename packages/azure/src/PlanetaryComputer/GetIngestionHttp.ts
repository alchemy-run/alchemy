import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetIngestion } from "./GetIngestion.ts";

/**
 * Implementation of {@link GetIngestion} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetIngestion
 */
export const GetIngestionHttp = Layer.effect(
  GetIngestion,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetIngestion",
    operation: geocatalog.GetIngestion,
    grant: GeoCatalogRole.Reader,
  }),
);
