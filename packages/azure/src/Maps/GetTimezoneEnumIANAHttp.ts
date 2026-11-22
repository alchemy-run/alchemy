import * as timezone from "@distilled.cloud/azure/maps-timezone";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { GetTimezoneEnumIANA } from "./GetTimezoneEnumIANA.ts";

/**
 * Implementation of {@link GetTimezoneEnumIANA} over the distilled `maps-timezone` data
 * plane. Assigns the custom `AzureMapsTimezoneReadRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.GetTimezoneEnumIANA
 */
export const GetTimezoneEnumIANAHttp = Layer.effect(
  GetTimezoneEnumIANA,
  makeMapsOperationBinding({
    tag: "Azure.Maps.GetTimezoneEnumIANA",
    operation: timezone.GetTimezoneTimezoneEnumIANA,
    grants: [MapsRole.TimezoneRead],
  }),
);
