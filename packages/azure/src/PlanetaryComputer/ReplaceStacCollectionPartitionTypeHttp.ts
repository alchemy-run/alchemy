import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { ReplaceStacCollectionPartitionType } from "./ReplaceStacCollectionPartitionType.ts";

/**
 * Implementation of {@link ReplaceStacCollectionPartitionType} over the
 * distilled `orbital-planetary-computer` data plane. Assigns **GeoCatalog
 * Administrator** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.ReplaceStacCollectionPartitionType
 */
export const ReplaceStacCollectionPartitionTypeHttp = Layer.effect(
  ReplaceStacCollectionPartitionType,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.ReplaceStacCollectionPartitionType",
    operation: geocatalog.ReplaceStacCollectionPartitionType,
    grant: GeoCatalogRole.Administrator,
  }),
);
