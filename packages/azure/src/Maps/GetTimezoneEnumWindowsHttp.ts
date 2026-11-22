import * as timezone from "@distilled.cloud/azure/maps-timezone";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { GetTimezoneEnumWindows } from "./GetTimezoneEnumWindows.ts";

/**
 * Implementation of {@link GetTimezoneEnumWindows} over the distilled `maps-timezone` data
 * plane. Assigns the custom `AzureMapsTimezoneReadRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.GetTimezoneEnumWindows
 */
export const GetTimezoneEnumWindowsHttp = Layer.effect(
  GetTimezoneEnumWindows,
  makeMapsOperationBinding({
    tag: "Azure.Maps.GetTimezoneEnumWindows",
    operation: timezone.GetTimezoneTimezoneEnumWindows,
    grants: [MapsRole.TimezoneRead],
  }),
);
