import * as route from "@distilled.cloud/azure/maps-route";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { GetRouteDirections } from "./GetRouteDirections.ts";

/**
 * Implementation of {@link GetRouteDirections} over the distilled `maps-route` data
 * plane. Assigns the custom `AzureMapsRouteReadRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.GetRouteDirections
 */
export const GetRouteDirectionsHttp = Layer.effect(
  GetRouteDirections,
  makeMapsOperationBinding({
    tag: "Azure.Maps.GetRouteDirections",
    operation: route.PostRouteRouteDirections,
    grants: [MapsRole.RouteRead],
  }),
);
