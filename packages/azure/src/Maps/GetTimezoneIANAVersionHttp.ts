import * as timezone from "@distilled.cloud/azure/maps-timezone";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { GetTimezoneIANAVersion } from "./GetTimezoneIANAVersion.ts";

/**
 * Implementation of {@link GetTimezoneIANAVersion} over the distilled `maps-timezone` data
 * plane. Assigns the custom `AzureMapsTimezoneReadRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.GetTimezoneIANAVersion
 */
export const GetTimezoneIANAVersionHttp = Layer.effect(
  GetTimezoneIANAVersion,
  makeMapsOperationBinding({
    tag: "Azure.Maps.GetTimezoneIANAVersion",
    operation: timezone.GetTimezoneTimezoneIANAVersion,
    grants: [MapsRole.TimezoneRead],
  }),
);
