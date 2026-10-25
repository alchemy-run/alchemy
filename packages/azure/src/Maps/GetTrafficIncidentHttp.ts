import * as traffic from "@distilled.cloud/azure/maps-traffic";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { GetTrafficIncident } from "./GetTrafficIncident.ts";

/**
 * Implementation of {@link GetTrafficIncident} over the distilled `maps-traffic` data
 * plane. Assigns the custom `AzureMapsTrafficReadRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.GetTrafficIncident
 */
export const GetTrafficIncidentHttp = Layer.effect(
  GetTrafficIncident,
  makeMapsOperationBinding({
    tag: "Azure.Maps.GetTrafficIncident",
    operation: traffic.GetTrafficTrafficIncident,
    grants: [MapsRole.TrafficRead],
  }),
);
