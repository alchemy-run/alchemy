import * as route from "@distilled.cloud/azure/maps-route";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { SnapToRoads } from "./SnapToRoads.ts";

/**
 * Implementation of {@link SnapToRoads} over the distilled `maps-route` data
 * plane. Assigns the custom `AzureMapsRouteReadRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.SnapToRoads
 */
export const SnapToRoadsHttp = Layer.effect(
  SnapToRoads,
  makeMapsOperationBinding({
    tag: "Azure.Maps.SnapToRoads",
    operation: route.PostRouteSnapToRoads,
    grants: [MapsRole.RouteRead],
  }),
);
