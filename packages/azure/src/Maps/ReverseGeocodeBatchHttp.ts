import * as search from "@distilled.cloud/azure/maps-search";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { ReverseGeocodeBatch } from "./ReverseGeocodeBatch.ts";

/**
 * Implementation of {@link ReverseGeocodeBatch} over the distilled `maps-search` data
 * plane. Assigns the custom `AzureMapsSearchReadRole` and `AzureMapsBatchRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.ReverseGeocodeBatch
 */
export const ReverseGeocodeBatchHttp = Layer.effect(
  ReverseGeocodeBatch,
  makeMapsOperationBinding({
    tag: "Azure.Maps.ReverseGeocodeBatch",
    operation: search.SearchGetReverseGeocodingBatch,
    grants: [MapsRole.SearchRead, MapsRole.Batch],
  }),
);
