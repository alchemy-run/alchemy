import * as timezone from "@distilled.cloud/azure/maps-timezone";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { GetTimezoneByID } from "./GetTimezoneByID.ts";

/**
 * Implementation of {@link GetTimezoneByID} over the distilled `maps-timezone` data
 * plane. Assigns the custom `AzureMapsTimezoneReadRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.GetTimezoneByID
 */
export const GetTimezoneByIDHttp = Layer.effect(
  GetTimezoneByID,
  makeMapsOperationBinding({
    tag: "Azure.Maps.GetTimezoneByID",
    operation: timezone.GetTimezoneTimezoneByID,
    grants: [MapsRole.TimezoneRead],
  }),
);
