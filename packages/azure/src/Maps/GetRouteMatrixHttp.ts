import * as route from "@distilled.cloud/azure/maps-route";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { GetRouteMatrix } from "./GetRouteMatrix.ts";

/**
 * Implementation of {@link GetRouteMatrix} over the distilled `maps-route` data
 * plane. Assigns the custom `AzureMapsRouteReadRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.GetRouteMatrix
 */
export const GetRouteMatrixHttp = Layer.effect(
  GetRouteMatrix,
  makeMapsOperationBinding({
    tag: "Azure.Maps.GetRouteMatrix",
    operation: route.PostRouteRouteMatrix,
    grants: [MapsRole.RouteRead],
  }),
);
