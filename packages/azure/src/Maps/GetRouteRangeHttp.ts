import * as route from "@distilled.cloud/azure/maps-route";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { GetRouteRange } from "./GetRouteRange.ts";

/**
 * Implementation of {@link GetRouteRange} over the distilled `maps-route` data
 * plane. Assigns the custom `AzureMapsRouteReadRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.GetRouteRange
 */
export const GetRouteRangeHttp = Layer.effect(
  GetRouteRange,
  makeMapsOperationBinding({
    tag: "Azure.Maps.GetRouteRange",
    operation: route.PostRouteRouteRange,
    grants: [MapsRole.RouteRead],
  }),
);
