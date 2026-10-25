import * as route from "@distilled.cloud/azure/maps-route";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { GetRouteOperationStatus } from "./GetRouteOperationStatus.ts";

/**
 * Implementation of {@link GetRouteOperationStatus} over the distilled `maps-route` data
 * plane. Assigns the custom `AzureMapsRouteReadRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.GetRouteOperationStatus
 */
export const GetRouteOperationStatusHttp = Layer.effect(
  GetRouteOperationStatus,
  makeMapsOperationBinding({
    tag: "Azure.Maps.GetRouteOperationStatus",
    operation: route.GetRouteRouteOperationsStatus,
    grants: [MapsRole.RouteRead],
  }),
);
