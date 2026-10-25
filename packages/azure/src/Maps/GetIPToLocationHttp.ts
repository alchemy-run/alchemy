import * as geolocation from "@distilled.cloud/azure/maps-geolocation";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { GetIPToLocation } from "./GetIPToLocation.ts";

/**
 * Implementation of {@link GetIPToLocation} over the distilled `maps-geolocation` data
 * plane. Assigns the custom `AzureMapsGeolocationReadRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.GetIPToLocation
 */
export const GetIPToLocationHttp = Layer.effect(
  GetIPToLocation,
  makeMapsOperationBinding({
    tag: "Azure.Maps.GetIPToLocation",
    operation: geolocation.GetGeolocationIPToLocation,
    grants: [MapsRole.GeolocationRead],
  }),
);
