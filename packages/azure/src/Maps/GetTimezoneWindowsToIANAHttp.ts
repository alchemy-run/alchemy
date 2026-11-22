import * as timezone from "@distilled.cloud/azure/maps-timezone";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { GetTimezoneWindowsToIANA } from "./GetTimezoneWindowsToIANA.ts";

/**
 * Implementation of {@link GetTimezoneWindowsToIANA} over the distilled `maps-timezone` data
 * plane. Assigns the custom `AzureMapsTimezoneReadRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.GetTimezoneWindowsToIANA
 */
export const GetTimezoneWindowsToIANAHttp = Layer.effect(
  GetTimezoneWindowsToIANA,
  makeMapsOperationBinding({
    tag: "Azure.Maps.GetTimezoneWindowsToIANA",
    operation: timezone.GetTimezoneTimezoneWindowsToIANA,
    grants: [MapsRole.TimezoneRead],
  }),
);
