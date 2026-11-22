import * as search from "@distilled.cloud/azure/maps-search";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { ReverseGeocode } from "./ReverseGeocode.ts";

/**
 * Implementation of {@link ReverseGeocode} over the distilled `maps-search` data
 * plane. Assigns the custom `AzureMapsSearchReadRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.ReverseGeocode
 */
export const ReverseGeocodeHttp = Layer.effect(
  ReverseGeocode,
  makeMapsOperationBinding({
    tag: "Azure.Maps.ReverseGeocode",
    operation: search.SearchGetReverseGeocoding,
    grants: [MapsRole.SearchRead],
  }),
);
