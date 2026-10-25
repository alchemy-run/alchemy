import * as route from "@distilled.cloud/azure/maps-route";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { GetRouteRangeBatch } from "./GetRouteRangeBatch.ts";

/**
 * Implementation of {@link GetRouteRangeBatch} over the distilled `maps-route` data
 * plane. Assigns the custom `AzureMapsRouteReadRole` and `AzureMapsBatchRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.GetRouteRangeBatch
 */
export const GetRouteRangeBatchHttp = Layer.effect(
  GetRouteRangeBatch,
  makeMapsOperationBinding({
    tag: "Azure.Maps.GetRouteRangeBatch",
    operation: route.PostRouteRouteRangeBatch,
    grants: [MapsRole.RouteRead, MapsRole.Batch],
  }),
);
