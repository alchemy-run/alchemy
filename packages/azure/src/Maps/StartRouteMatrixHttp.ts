import * as route from "@distilled.cloud/azure/maps-route";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { StartRouteMatrix } from "./StartRouteMatrix.ts";

/**
 * Implementation of {@link StartRouteMatrix} over the distilled `maps-route` data
 * plane. Assigns the custom `AzureMapsRouteReadRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.StartRouteMatrix
 */
export const StartRouteMatrixHttp = Layer.effect(
  StartRouteMatrix,
  makeMapsOperationBinding({
    tag: "Azure.Maps.StartRouteMatrix",
    operation: route.PostRouteRouteMatrixAsync,
    grants: [MapsRole.RouteRead],
  }),
);
