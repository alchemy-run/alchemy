import * as route from "@distilled.cloud/azure/maps-route";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { SnapToRoadsBatch } from "./SnapToRoadsBatch.ts";

/**
 * Implementation of {@link SnapToRoadsBatch} over the distilled `maps-route` data
 * plane. Assigns the custom `AzureMapsRouteReadRole` and `AzureMapsBatchRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.SnapToRoadsBatch
 */
export const SnapToRoadsBatchHttp = Layer.effect(
  SnapToRoadsBatch,
  makeMapsOperationBinding({
    tag: "Azure.Maps.SnapToRoadsBatch",
    operation: route.PostRouteSnapToRoadsBatch,
    grants: [MapsRole.RouteRead, MapsRole.Batch],
  }),
);
