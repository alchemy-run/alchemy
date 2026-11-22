import * as route from "@distilled.cloud/azure/maps-route";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { GetRouteDirectionsBatch } from "./GetRouteDirectionsBatch.ts";

/**
 * Implementation of {@link GetRouteDirectionsBatch} over the distilled `maps-route` data
 * plane. Assigns the custom `AzureMapsRouteReadRole` and `AzureMapsBatchRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.GetRouteDirectionsBatch
 */
export const GetRouteDirectionsBatchHttp = Layer.effect(
  GetRouteDirectionsBatch,
  makeMapsOperationBinding({
    tag: "Azure.Maps.GetRouteDirectionsBatch",
    operation: route.PostRouteRouteDirectionsBatch,
    grants: [MapsRole.RouteRead, MapsRole.Batch],
  }),
);
