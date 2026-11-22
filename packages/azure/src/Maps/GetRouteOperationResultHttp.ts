import * as route from "@distilled.cloud/azure/maps-route";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { GetRouteOperationResult } from "./GetRouteOperationResult.ts";

/**
 * Implementation of {@link GetRouteOperationResult} over the distilled `maps-route` data
 * plane. Assigns the custom `AzureMapsRouteReadRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.GetRouteOperationResult
 */
export const GetRouteOperationResultHttp = Layer.effect(
  GetRouteOperationResult,
  makeMapsOperationBinding({
    tag: "Azure.Maps.GetRouteOperationResult",
    operation: route.GetRouteRouteOperationsResult,
    grants: [MapsRole.RouteRead],
  }),
);
