import * as timezone from "@distilled.cloud/azure/maps-timezone";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { GetTimezoneByCoordinates } from "./GetTimezoneByCoordinates.ts";

/**
 * Implementation of {@link GetTimezoneByCoordinates} over the distilled `maps-timezone` data
 * plane. Assigns the custom `AzureMapsTimezoneReadRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.GetTimezoneByCoordinates
 */
export const GetTimezoneByCoordinatesHttp = Layer.effect(
  GetTimezoneByCoordinates,
  makeMapsOperationBinding({
    tag: "Azure.Maps.GetTimezoneByCoordinates",
    operation: timezone.GetTimezoneTimezoneByCoordinates,
    grants: [MapsRole.TimezoneRead],
  }),
);
