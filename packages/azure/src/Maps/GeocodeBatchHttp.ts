import * as search from "@distilled.cloud/azure/maps-search";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { GeocodeBatch } from "./GeocodeBatch.ts";

/**
 * Implementation of {@link GeocodeBatch} over the distilled `maps-search` data
 * plane. Assigns the custom `AzureMapsSearchReadRole` and `AzureMapsBatchRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.GeocodeBatch
 */
export const GeocodeBatchHttp = Layer.effect(
  GeocodeBatch,
  makeMapsOperationBinding({
    tag: "Azure.Maps.GeocodeBatch",
    operation: search.SearchGetGeocodingBatch,
    grants: [MapsRole.SearchRead, MapsRole.Batch],
  }),
);
