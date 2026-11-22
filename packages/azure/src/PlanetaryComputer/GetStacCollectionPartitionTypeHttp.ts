import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetStacCollectionPartitionType } from "./GetStacCollectionPartitionType.ts";

/**
 * Implementation of {@link GetStacCollectionPartitionType} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetStacCollectionPartitionType
 */
export const GetStacCollectionPartitionTypeHttp = Layer.effect(
  GetStacCollectionPartitionType,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetStacCollectionPartitionType",
    operation: geocatalog.GetStacCollectionPartitionType,
    grant: GeoCatalogRole.Reader,
  }),
);
