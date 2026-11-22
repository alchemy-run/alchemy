import * as search from "@distilled.cloud/azure/maps-search";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { Geocode } from "./Geocode.ts";

/**
 * Implementation of {@link Geocode} over the distilled `maps-search` data
 * plane. Assigns the custom `AzureMapsSearchReadRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.Geocode
 */
export const GeocodeHttp = Layer.effect(
  Geocode,
  makeMapsOperationBinding({
    tag: "Azure.Maps.Geocode",
    operation: search.SearchGetGeocoding,
    grants: [MapsRole.SearchRead],
  }),
);
